import { beforeEach, describe, expect, test } from 'vitest'
import { algorandFixture } from '../testing'
import { generateTestAsset } from '../testing/_asset'
import type { SigningAccount } from './account'

interface LoadTestConfig {
  totalRuns: number
  maxParallelThreads: number
}

interface LoadTestResult {
  success: boolean
  runNumber: number
  error: string | null
  indexerLagMs?: number
  workTimeMs?: number
}

interface LoadTestSummary {
  totalRuns: number
  successCount: number
  failureCount: number
  successRate: number
  duration: number
  throughput: number
  failures: LoadTestResult[]
  indexerLagStats?: {
    min: number
    max: number
    avg: number
    median: number
    stdDev: number
    p5: number
    p75: number
    p90: number
    p99: number
  }
}

describe('Asset Load Testing', () => {
  const localnet = algorandFixture()
  beforeEach(localnet.newScope, 100_000)

  // Helper function to run a single OptIn/OptOut test
  async function singleOptInOptOutTest(testName: string, runNumber: number) {
    const { algorand, generateAccount } = localnet.context
    const testAccount = await generateAccount({ initialFunds: (1).algo() })
    const dummyAssetId = await generateTestAsset(algorand, testAccount, 0)
    const secondAccount = await generateAccount({ initialFunds: (1).algo() })

    try {
      // OptIn
      await algorand.send.assetOptIn({ sender: secondAccount, assetId: dummyAssetId })

      const secondAccountInfo = await algorand.account.getInformation(secondAccount)
      expect(secondAccountInfo.totalAssetsOptedIn).toBe(1)

      // OptOut
      await algorand.send.assetOptOut({
        sender: secondAccount,
        creator: testAccount,
        assetId: dummyAssetId,
        ensureZeroBalance: true,
      })

      const secondAccountInfoAfterOptOut = await algorand.account.getInformation(secondAccount)
      expect(secondAccountInfoAfterOptOut.totalAssetsOptedIn).toBe(0)

      return { success: true, runNumber, error: null }
    } catch (error) {
      return { success: false, runNumber, error: error instanceof Error ? error.message : String(error) }
    }
  }

  // Helper function to run tests in parallel with simple thread division
  async function runLoadTest(config: LoadTestConfig, testName: string): Promise<LoadTestSummary> {
    const { totalRuns, maxParallelThreads } = config
    const startTime = Date.now()

    // Calculate runs per thread
    const runsPerThread = Math.ceil(totalRuns / maxParallelThreads)

    // Function to run multiple tests in sequence for one thread
    const runThreadTests = async (threadId: number): Promise<LoadTestResult[]> => {
      const results: LoadTestResult[] = []
      const startRun = threadId * runsPerThread + 1
      const endRun = Math.min(startRun + runsPerThread - 1, totalRuns)

      for (let runNumber = startRun; runNumber <= endRun; runNumber++) {
        const result = await singleOptInOptOutTest(testName, runNumber)
        results.push(result)
      }

      return results
    }

    // Start all threads in parallel
    const threadPromises: Promise<LoadTestResult[]>[] = []
    for (let threadId = 0; threadId < maxParallelThreads; threadId++) {
      threadPromises.push(runThreadTests(threadId))
    }

    // Wait for all threads to complete and collect results
    const threadResults = await Promise.all(threadPromises)
    const results = threadResults.flat()

    const endTime = Date.now()
    const duration = (endTime - startTime) / 1000

    // Final results
    const successCount = results.filter((r) => r.success).length
    const failureCount = results.filter((r) => !r.success).length
    const successRate = (successCount / totalRuns) * 100

    const failures = results.filter((r) => !r.success)

    return {
      totalRuns,
      successCount,
      failureCount,
      successRate,
      duration,
      throughput: totalRuns / duration,
      failures,
    }
  } // This test is conditional to avoid running during normal test execution
  // To run this test, use: $env:LOAD_TEST="true"; npm test -- --run -t "Load test localnet node"
  test('Load test localnet node', async () => {
    // Skip if not explicitly requested
    if (!process.env.LOAD_TEST) {
      return
    }

    // Lightweight load test configuration - adjust as needed
    const config: LoadTestConfig = {
      totalRuns: 50000,
      maxParallelThreads: 4,
    }

    const results = await runLoadTest(config, 'Localnet OptIn/OptOut Load Test')

    // Basic assertions
    expect(results.totalRuns).toBe(config.totalRuns)
    expect(results.successCount + results.failureCount).toBe(config.totalRuns)
    expect(results.throughput).toBeGreaterThan(0) // Should have some throughput

    // Log results for manual inspection
    // eslint-disable-next-line no-console
    console.log(`\n--- Load Test Results ---`)
    // eslint-disable-next-line no-console
    console.log(`Total runs: ${results.totalRuns}`)
    // eslint-disable-next-line no-console
    console.log(`Successful: ${results.successCount}`)
    // eslint-disable-next-line no-console
    console.log(`Failed: ${results.failureCount}`)
    // eslint-disable-next-line no-console
    console.log(`Success rate: ${results.successRate.toFixed(2)}%`)
    // eslint-disable-next-line no-console
    console.log(`Duration: ${results.duration.toFixed(2)} seconds`)
    // eslint-disable-next-line no-console
    console.log(`Throughput: ${results.throughput.toFixed(2)} runs/second`)

    if (results.failures.length > 0) {
      // eslint-disable-next-line no-console
      console.log(`\n--- Failures ---`)
      results.failures.forEach((failure) => {
        // eslint-disable-next-line no-console
        console.log(`Run ${failure.runNumber}: ${failure.error}`)
      })
    }
  }, 300_000) // 5 minute timeout

  // Helper function to run payment load test with multiple threads
  async function runPaymentLoadTest(
    numThreads: number,
    totalRounds: number,
    indexerWaitTimeMs: number,
  ): Promise<LoadTestSummary> {
    const { algorand, generateAccount } = localnet.context

    // Create one wallet per thread, funded for worst case (all rounds could go through one wallet)
    // Each wallet needs totalRounds Algo to send + extra for fees (0.001 Algo per txn)
    const fundingAmount = totalRounds + 1 // Extra 1 Algo for fees
    const wallets: SigningAccount[] = []

    for (let i = 0; i < numThreads; i++) {
      const wallet = await generateAccount({ initialFunds: (fundingAmount).algo() })
      wallets.push(wallet)
    }

    // Atomic counter for remaining rounds (shared across all threads)
    let remainingRounds = totalRounds

    // Start timing after wallet setup is complete
    const startTime = Date.now()

    // Helper function to run a single payment test
    async function singlePaymentTest(runNumber: number, threadId: number): Promise<LoadTestResult> {
      try {
        // Start timing the actual work (transaction + indexer catchup)
        const workStartTime = Date.now()

        const sender = wallets[threadId]
        // Get all other wallets (excluding current thread's wallet)
        const receivers = wallets.filter((_, index) => index !== threadId)
        // Select random receiver from other threads' wallets
        const receiver = receivers[Math.floor(Math.random() * receivers.length)]

        // Send 1 Algo payment
        const result = await algorand.send.payment({
          sender,
          receiver: receiver.addr,
          amount: (1).algo(),
        })

        // Measure indexer lag - how long until indexer catches up to this round
        const confirmedRound = result.confirmation.confirmedRound!
        const indexerStartTime = Date.now()
        let indexerLagMs = 0
        let tries = 0
        const maxTries = Math.ceil(indexerWaitTimeMs / 1) // Check every 1ms for maximum accuracy

        // Poll indexer until it catches up to the confirmed round
        // Poll as fast as possible (no delay) for accurate performance measurement
        while (tries < maxTries) {
          try {
            const indexerHealth = await algorand.client.indexer.makeHealthCheck().do()
            const indexerRound = indexerHealth.round

            if (indexerRound >= confirmedRound) {
              indexerLagMs = Date.now() - indexerStartTime
              break
            }
          } catch (error) {
            // If health check fails, log but continue trying
            // This could happen if indexer is temporarily unavailable
          }

          tries++
          // No delay - poll as fast as possible
        }

        // If we hit the timeout, record the timeout duration
        if (tries >= maxTries) {
          indexerLagMs = Date.now() - indexerStartTime
        }

        // End timing the actual work
        const workTimeMs = Date.now() - workStartTime

        // Random sleep between 10-1000ms before next transaction (outside of timing)
        const sleepMs = Math.floor(Math.random() * 991) + 10 // 10 to 1000ms
        await new Promise((resolve) => setTimeout(resolve, sleepMs))

        return { success: true, runNumber, error: null, indexerLagMs, workTimeMs }
      } catch (error) {
        return { success: false, runNumber, error: error instanceof Error ? error.message : String(error) }
      }
    }

    // Function to run tests in sequence for one thread
    // Each thread pulls from the shared atomic counter until all rounds are complete
    const runThreadTests = async (threadId: number): Promise<LoadTestResult[]> => {
      const results: LoadTestResult[] = []

      while (remainingRounds > 0) {
        // Atomically decrement the counter and get the current run number
        const runNumber = totalRounds - remainingRounds + 1
        remainingRounds--

        // If we've gone past the total, break (shouldn't happen but safety check)
        if (runNumber > totalRounds) {
          break
        }

        const result = await singlePaymentTest(runNumber, threadId)
        results.push(result)
      }

      return results
    }

    // Start all threads in parallel
    const threadPromises: Promise<LoadTestResult[]>[] = []
    for (let threadId = 0; threadId < numThreads; threadId++) {
      threadPromises.push(runThreadTests(threadId))
    }

    // Wait for all threads to complete and collect results
    const threadResults = await Promise.all(threadPromises)
    const results = threadResults.flat()

    const endTime = Date.now()
    const wallClockDuration = (endTime - startTime) / 1000

    // Calculate total work time (excluding sleep delays)
    const totalWorkTimeMs = results.filter((r) => r.success && r.workTimeMs !== undefined).reduce((sum, r) => sum + r.workTimeMs!, 0)
    const workDuration = totalWorkTimeMs / 1000

    // Final results
    const successCount = results.filter((r) => r.success).length
    const failureCount = results.filter((r) => !r.success).length
    const successRate = (successCount / totalRounds) * 100

    const failures = results.filter((r) => !r.success)

    // Calculate indexer lag statistics
    const indexerLags = results.filter((r) => r.success && r.indexerLagMs !== undefined).map((r) => r.indexerLagMs!)
    let indexerLagStats
    if (indexerLags.length > 0) {
      const sortedLags = [...indexerLags].sort((a, b) => a - b)
      const avg = indexerLags.reduce((sum, lag) => sum + lag, 0) / indexerLags.length

      // Calculate standard deviation
      const variance = indexerLags.reduce((sum, lag) => sum + Math.pow(lag - avg, 2), 0) / indexerLags.length
      const stdDev = Math.sqrt(variance)

      // Helper function to get percentile value
      const getPercentile = (p: number) => {
        const index = Math.ceil((p / 100) * sortedLags.length) - 1
        return sortedLags[Math.max(0, index)]
      }

      indexerLagStats = {
        min: sortedLags[0],
        max: sortedLags[sortedLags.length - 1],
        avg,
        median: sortedLags[Math.floor(sortedLags.length / 2)],
        stdDev,
        p5: getPercentile(5),
        p75: getPercentile(75),
        p90: getPercentile(90),
        p99: getPercentile(99),
      }
    }

    return {
      totalRuns: totalRounds,
      successCount,
      failureCount,
      successRate,
      duration: workDuration,
      throughput: totalRounds / workDuration,
      failures,
      indexerLagStats,
    }
  } // This test is conditional to avoid running during normal test execution
  // To run this test, use: $env:LOAD_TEST="true"; $env:NUM_THREADS="5"; $env:NUM_ROUNDS="10000"; $env:INDEXER_WAIT_TIME_MS="5000"; npm test -- --run -t "Performance test indexer lag"
  // NUM_ROUNDS is the total number of transactions across all threads (not per-thread)
  test('Performance test indexer lag', async () => {
    // Skip if not explicitly requested
    if (!process.env.LOAD_TEST) {
      return
    }

    // Load test configuration from environment variables - adjust as needed
    const numThreads = parseInt(process.env.NUM_THREADS || '5', 10)
    const numRounds = parseInt(process.env.NUM_ROUNDS || '10000', 10) // Total rounds across all threads
    const indexerWaitTimeMs = parseInt(process.env.INDEXER_WAIT_TIME_MS || '5000', 10)

    const results = await runPaymentLoadTest(numThreads, numRounds, indexerWaitTimeMs)

    // Basic assertions
    expect(results.totalRuns).toBe(numRounds)
    expect(results.successCount + results.failureCount).toBe(results.totalRuns)
    expect(results.throughput).toBeGreaterThan(0) // Should have some throughput

    // Log results for manual inspection
    // eslint-disable-next-line no-console
    console.log(`\n--- Performance Test Results: Indexer Lag ---`)
    // eslint-disable-next-line no-console
    console.log(`Configuration: ${numThreads} threads, ${numRounds} total rounds`)
    // eslint-disable-next-line no-console
    console.log(`Indexer wait timeout: ${indexerWaitTimeMs} ms`)
    // eslint-disable-next-line no-console
    console.log(`Total runs: ${results.totalRuns}`)
    // eslint-disable-next-line no-console
    console.log(`Successful: ${results.successCount}`)
    // eslint-disable-next-line no-console
    console.log(`Failed: ${results.failureCount}`)
    // eslint-disable-next-line no-console
    console.log(`Success rate: ${results.successRate.toFixed(2)}%`)
    // eslint-disable-next-line no-console
    console.log(`Work duration: ${results.duration.toFixed(2)} seconds (excludes random sleep delays)`)
    // eslint-disable-next-line no-console
    console.log(`Throughput: ${results.throughput.toFixed(2)} transactions/second`)

    if (results.indexerLagStats) {
      // eslint-disable-next-line no-console
      console.log(`\n--- Indexer Lag Statistics ---`)
      // eslint-disable-next-line no-console
      console.log(`Min lag: ${results.indexerLagStats.min.toFixed(2)} ms`)
      // eslint-disable-next-line no-console
      console.log(`Max lag: ${results.indexerLagStats.max.toFixed(2)} ms`)
      // eslint-disable-next-line no-console
      console.log(`Average lag: ${results.indexerLagStats.avg.toFixed(2)} ms`)
      // eslint-disable-next-line no-console
      console.log(`Median lag: ${results.indexerLagStats.median.toFixed(2)} ms`)
      // eslint-disable-next-line no-console
      console.log(`Std deviation: ${results.indexerLagStats.stdDev.toFixed(2)} ms`)
      // eslint-disable-next-line no-console
      console.log(`P5 lag: ${results.indexerLagStats.p5.toFixed(2)} ms`)
      // eslint-disable-next-line no-console
      console.log(`P75 lag: ${results.indexerLagStats.p75.toFixed(2)} ms`)
      // eslint-disable-next-line no-console
      console.log(`P90 lag: ${results.indexerLagStats.p90.toFixed(2)} ms`)
      // eslint-disable-next-line no-console
      console.log(`P99 lag: ${results.indexerLagStats.p99.toFixed(2)} ms`)
    }

    if (results.failures.length > 0) {
      // eslint-disable-next-line no-console
      console.log(`\n--- Failures ---`)
      results.failures.forEach((failure) => {
        // eslint-disable-next-line no-console
        console.log(`Run ${failure.runNumber}: ${failure.error}`)
      })
    }
  }, 600_000) // 10 minute timeout
})
