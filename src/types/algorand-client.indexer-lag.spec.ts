// ============================================================================
// IMPORTS
// ============================================================================
import { beforeEach, describe, expect, test } from 'vitest'
import { algorandFixture } from '../testing'
import { generateTestAsset } from '../testing/_asset'
import type { SigningAccount } from './account'
import * as fs from 'fs'
import * as path from 'path'

// ============================================================================
// TYPE DEFINITIONS
// ============================================================================
interface LoadTestResult {
  success: boolean
  runNumber: number
  error: string | null
  indexerLagMs?: number
  workTimeMs?: number
}

interface BatchStats {
  batchNumber: number
  startRun: number
  endRun: number
  successCount: number
  failureCount: number
  successRate: number
  indexerLagStats?: {
    min: number
    max: number
    avg: number
    median: number
    stdDev: number
    p50: number
    p75: number
    p90: number
    p99: number
  }
}

interface LoadTestSummary {
  totalRuns: number
  successCount: number
  failureCount: number
  successRate: number
  duration: number
  throughput: number
  failures: LoadTestResult[]
  allResults: LoadTestResult[]
  errorCounts: Record<string, number>
  indexerLagStats?: {
    min: number
    max: number
    avg: number
    median: number
    stdDev: number
    p50: number
    p75: number
    p90: number
    p99: number
  }
  operationTimeStats?: {
    min: number
    max: number
    avg: number
    median: number
    stdDev: number
    p50: number
    p75: number
    p90: number
    p99: number
  }
  batchStats?: BatchStats[]
}

describe('Indexer Lag Performance Tests', () => {
  const localnet = algorandFixture()
  beforeEach(localnet.newScope, 100_000)

  // ==========================================================================
  // CONFIGURATION HELPERS
  // ==========================================================================
  const getLoadTestTimeout = () => parseInt(process.env.LOAD_TEST_TIMEOUT_MS || '64800000', 10) // 18 hours default
  const getNumThreads = () => parseInt(process.env.NUM_THREADS || '5', 10)
  const getNumRounds = () => parseInt(process.env.NUM_ROUNDS || '1000', 10)
  const getIndexerWaitTimeMs = () => parseInt(process.env.INDEXER_WAIT_TIME_MS || '30000', 10) // 30 seconds default
  const getIndexerPollIntervalMs = () => parseInt(process.env.INDEXER_POLL_INTERVAL_MS || '5', 10)
  const getLocalnetConfig = () => process.env.LOCALNET_CONFIG || 'original' // 'original' or 'lead-node-following'

  // ==========================================================================
  // STATISTICS CALCULATION FUNCTIONS
  // ==========================================================================
  function calculateIndexerLagStats(results: LoadTestResult[]) {
    const indexerLags = results.filter((r) => r.success && r.indexerLagMs !== undefined).map((r) => r.indexerLagMs!)
    if (indexerLags.length === 0) return undefined

    const sortedLags = [...indexerLags].sort((a, b) => a - b)
    const avg = indexerLags.reduce((sum, lag) => sum + lag, 0) / indexerLags.length
    const variance = indexerLags.reduce((sum, lag) => sum + Math.pow(lag - avg, 2), 0) / indexerLags.length
    const stdDev = Math.sqrt(variance)

    const getPercentile = (p: number) => {
      const index = Math.ceil((p / 100) * sortedLags.length) - 1
      return sortedLags[Math.max(0, index)]
    }

    return {
      min: sortedLags[0],
      max: sortedLags[sortedLags.length - 1],
      avg,
      median: sortedLags[Math.floor(sortedLags.length / 2)],
      stdDev,
      p50: getPercentile(50),
      p75: getPercentile(75),
      p90: getPercentile(90),
      p99: getPercentile(99),
    }
  }

  function calculateOperationTimeStats(results: LoadTestResult[]) {
    const operationTimes = results.filter((r) => r.success && r.workTimeMs !== undefined).map((r) => r.workTimeMs!)
    if (operationTimes.length === 0) return undefined

    const sortedTimes = [...operationTimes].sort((a, b) => a - b)
    const avg = operationTimes.reduce((sum, time) => sum + time, 0) / operationTimes.length
    const variance = operationTimes.reduce((sum, time) => sum + Math.pow(time - avg, 2), 0) / operationTimes.length
    const stdDev = Math.sqrt(variance)

    const getPercentile = (p: number) => {
      const index = Math.ceil((p / 100) * sortedTimes.length) - 1
      return sortedTimes[Math.max(0, index)]
    }

    return {
      min: sortedTimes[0],
      max: sortedTimes[sortedTimes.length - 1],
      avg,
      median: sortedTimes[Math.floor(sortedTimes.length / 2)],
      stdDev,
      p50: getPercentile(50),
      p75: getPercentile(75),
      p90: getPercentile(90),
      p99: getPercentile(99),
    }
  }

  function calculateBatchStats(results: LoadTestResult[], batchSize = 1000): BatchStats[] {
    const batches: BatchStats[] = []
    const numBatches = Math.ceil(results.length / batchSize)

    for (let i = 0; i < numBatches; i++) {
      const startIdx = i * batchSize
      const endIdx = Math.min(startIdx + batchSize, results.length)
      const batchResults = results.slice(startIdx, endIdx)

      const successCount = batchResults.filter((r) => r.success).length
      const failureCount = batchResults.filter((r) => !r.success).length
      const successRate = (successCount / batchResults.length) * 100

      batches.push({
        batchNumber: i + 1,
        startRun: batchResults[0].runNumber,
        endRun: batchResults[batchResults.length - 1].runNumber,
        successCount,
        failureCount,
        successRate,
        indexerLagStats: calculateIndexerLagStats(batchResults),
      })
    }

    return batches
  }

  function calculateLagHistogram(results: LoadTestResult[]) {
    const buckets = [0, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 8000, 10000, 12000, 15000, 20000, 25000, 30000]
    const histogram: Record<string, number> = {}

    // Initialize buckets
    for (let i = 0; i < buckets.length; i++) {
      if (i === buckets.length - 1) {
        histogram[`${buckets[i]}+`] = 0
      } else {
        histogram[`${buckets[i]}-${buckets[i + 1]}`] = 0
      }
    }

    // Count results in each bucket
    const lags = results.filter((r) => r.success && r.indexerLagMs !== undefined).map((r) => r.indexerLagMs!)

    for (const lag of lags) {
      let placed = false
      for (let i = 0; i < buckets.length - 1; i++) {
        if (lag >= buckets[i] && lag < buckets[i + 1]) {
          histogram[`${buckets[i]}-${buckets[i + 1]}`]++
          placed = true
          break
        }
      }
      if (!placed) {
        histogram[`${buckets[buckets.length - 1]}+`]++
      }
    }

    return { histogram, totalCount: lags.length }
  }

  // ==========================================================================
  // DISPLAY & OUTPUT FUNCTIONS
  // ==========================================================================
  function displayBatchStats(batchStats: BatchStats[]) {
    // eslint-disable-next-line no-console
    console.log(`\n### Batch Statistics (per 500 operations)\n`)
    // eslint-disable-next-line no-console
    console.log(`| Batch | Runs | Success | Fail | Success% | Min Lag | Avg Lag | Median | P90 | P99 | Max Lag |`)
    // eslint-disable-next-line no-console
    console.log(`|-------|------|---------|------|----------|---------|---------|--------|-----|-----|---------|`)

    for (const batch of batchStats) {
      if (batch.indexerLagStats) {
        const stats = batch.indexerLagStats
        // eslint-disable-next-line no-console
        console.log(
          `| ${batch.batchNumber} | ${batch.startRun}-${batch.endRun} | ${batch.successCount} | ${batch.failureCount} | ${batch.successRate.toFixed(1)}% | ${stats.min.toFixed(0)} | ${stats.avg.toFixed(0)} | ${stats.median.toFixed(0)} | ${stats.p90.toFixed(0)} | ${stats.p99.toFixed(0)} | ${stats.max.toFixed(0)} |`,
        )
      } else {
        // eslint-disable-next-line no-console
        console.log(
          `| ${batch.batchNumber} | ${batch.startRun}-${batch.endRun} | ${batch.successCount} | ${batch.failureCount} | ${batch.successRate.toFixed(1)}% | - | - | - | - | - | - |`,
        )
      }
    }
  }

  function displayLagHistogram(results: LoadTestResult[]) {
    const { histogram, totalCount } = calculateLagHistogram(results)

    if (totalCount === 0) {
      // eslint-disable-next-line no-console
      console.log(`\n### Indexer Lag Histogram\n`)
      // eslint-disable-next-line no-console
      console.log(`_No lag data available_`)
      return
    }

    // eslint-disable-next-line no-console
    console.log(`\n### Indexer Lag Histogram\n`)
    // eslint-disable-next-line no-console
    console.log(`| Lag Range (ms) | Count | Percentage | Distribution |`)
    // eslint-disable-next-line no-console
    console.log(`|----------------|-------|------------|--------------|`)

    const bucketKeys = Object.keys(histogram)
    for (const key of bucketKeys) {
      const count = histogram[key]
      const percentage = ((count / totalCount) * 100).toFixed(2)
      const barLength = Math.round((count / totalCount) * 50)
      const bar = '█'.repeat(barLength)

      // eslint-disable-next-line no-console
      console.log(`| ${key} | ${count} | ${percentage}% | ${bar} |`)
    }

    // eslint-disable-next-line no-console
    console.log(`\n_Total operations with lag data: ${totalCount}_`)
  }

  function writeResultsToCSV(
    results: LoadTestResult[],
    testType: string,
    numRuns: number,
    config: string,
  ): string {
    const resultsDir = path.join(process.cwd(), 'results')

    // Create results directory if it doesn't exist
    if (!fs.existsSync(resultsDir)) {
      fs.mkdirSync(resultsDir, { recursive: true })
    }

    // Generate timestamp in ISO format (replace colons with hyphens for filename compatibility)
    const timestamp = new Date().toISOString().replace(/:/g, '-').replace(/\..+/, '')

    // Generate filename
    const filename = `${testType}_${numRuns}-runs_${config}_${timestamp}.csv`
    const filepath = path.join(resultsDir, filename)

    // Create CSV header
    const header = 'runNumber,success,error,indexerLagMs,workTimeMs\n'

    // Create CSV rows
    const rows = results
      .map((r) => {
        const runNumber = r.runNumber
        const success = r.success
        const error = r.error ? `"${r.error.replace(/"/g, '""')}"` : '' // Escape quotes in error messages
        const indexerLagMs = r.indexerLagMs !== undefined ? r.indexerLagMs.toFixed(2) : ''
        const workTimeMs = r.workTimeMs !== undefined ? r.workTimeMs.toFixed(2) : ''
        return `${runNumber},${success},${error},${indexerLagMs},${workTimeMs}`
      })
      .join('\n')

    // Write to file
    const csvContent = header + rows
    fs.writeFileSync(filepath, csvContent, 'utf-8')

    return filepath
  }

  function displayIndexerLagTestResults(
    results: LoadTestSummary,
    testName: string,
    csvFilename: string,
    config: { numThreads: number; numRounds: number; indexerWaitTimeMs: number; indexerPollIntervalMs: number },
  ) {
    // eslint-disable-next-line no-console
    console.log(`\n## Performance Test Results: ${testName}\n`)

    // Configuration section
    // eslint-disable-next-line no-console
    console.log(`### Configuration\n`)
    // eslint-disable-next-line no-console
    console.log(`- **Threads:** ${config.numThreads}`)
    // eslint-disable-next-line no-console
    console.log(`- **Total Rounds:** ${config.numRounds}`)
    // eslint-disable-next-line no-console
    console.log(`- **Indexer Wait Timeout:** ${config.indexerWaitTimeMs} ms`)
    // eslint-disable-next-line no-console
    console.log(`- **Indexer Poll Interval:** ${config.indexerPollIntervalMs} ms\n`)

    // Overall results section
    // eslint-disable-next-line no-console
    console.log(`### Overall Results\n`)
    // eslint-disable-next-line no-console
    console.log(`| Metric | Value |`)
    // eslint-disable-next-line no-console
    console.log(`|--------|-------|`)
    // eslint-disable-next-line no-console
    console.log(`| Total Runs | ${results.totalRuns} |`)
    // eslint-disable-next-line no-console
    console.log(`| Successful | ${results.successCount} |`)
    // eslint-disable-next-line no-console
    console.log(`| Failed | ${results.failureCount} |`)
    // eslint-disable-next-line no-console
    console.log(`| Success Rate | ${results.successRate.toFixed(2)}% |`)
    // eslint-disable-next-line no-console
    console.log(`| Work Duration | ${results.duration.toFixed(2)}s |`)
    // eslint-disable-next-line no-console
    console.log(`| Throughput | ${results.throughput.toFixed(2)} ops/s |`)

    // Display error breakdown if there are failures
    if (results.failureCount > 0 && Object.keys(results.errorCounts).length > 0) {
      // eslint-disable-next-line no-console
      console.log(`\n### Error Breakdown\n`)
      const sortedErrors = Object.entries(results.errorCounts).sort((a, b) => b[1] - a[1])
      // eslint-disable-next-line no-console
      console.log(`| Error Type | Count |`)
      // eslint-disable-next-line no-console
      console.log(`|------------|-------|`)
      for (const [errorType, count] of sortedErrors) {
        // eslint-disable-next-line no-console
        console.log(`| ${errorType} | ${count} |`)
      }
    }

    if (results.indexerLagStats) {
      // eslint-disable-next-line no-console
      console.log(`\n### Indexer Lag Statistics\n`)
      // eslint-disable-next-line no-console
      console.log(`| Statistic | Value (ms) |`)
      // eslint-disable-next-line no-console
      console.log(`|-----------|------------|`)
      // eslint-disable-next-line no-console
      console.log(`| Min | ${results.indexerLagStats.min.toFixed(2)} |`)
      // eslint-disable-next-line no-console
      console.log(`| Max | ${results.indexerLagStats.max.toFixed(2)} |`)
      // eslint-disable-next-line no-console
      console.log(`| Average | ${results.indexerLagStats.avg.toFixed(2)} |`)
      // eslint-disable-next-line no-console
      console.log(`| Median | ${results.indexerLagStats.median.toFixed(2)} |`)
      // eslint-disable-next-line no-console
      console.log(`| Std Deviation | ${results.indexerLagStats.stdDev.toFixed(2)} |`)
      // eslint-disable-next-line no-console
      console.log(`| P50 | ${results.indexerLagStats.p50.toFixed(2)} |`)
      // eslint-disable-next-line no-console
      console.log(`| P75 | ${results.indexerLagStats.p75.toFixed(2)} |`)
      // eslint-disable-next-line no-console
      console.log(`| P90 | ${results.indexerLagStats.p90.toFixed(2)} |`)
      // eslint-disable-next-line no-console
      console.log(`| P99 | ${results.indexerLagStats.p99.toFixed(2)} |`)
    }

    if (results.operationTimeStats) {
      // eslint-disable-next-line no-console
      console.log(`\n### Operation Time Statistics\n`)
      // eslint-disable-next-line no-console
      console.log(`| Statistic | Value (ms) |`)
      // eslint-disable-next-line no-console
      console.log(`|-----------|------------|`)
      // eslint-disable-next-line no-console
      console.log(`| Min | ${results.operationTimeStats.min.toFixed(2)} |`)
      // eslint-disable-next-line no-console
      console.log(`| Max | ${results.operationTimeStats.max.toFixed(2)} |`)
      // eslint-disable-next-line no-console
      console.log(`| Average | ${results.operationTimeStats.avg.toFixed(2)} |`)
      // eslint-disable-next-line no-console
      console.log(`| Median | ${results.operationTimeStats.median.toFixed(2)} |`)
      // eslint-disable-next-line no-console
      console.log(`| Std Deviation | ${results.operationTimeStats.stdDev.toFixed(2)} |`)
      // eslint-disable-next-line no-console
      console.log(`| P50 | ${results.operationTimeStats.p50.toFixed(2)} |`)
      // eslint-disable-next-line no-console
      console.log(`| P75 | ${results.operationTimeStats.p75.toFixed(2)} |`)
      // eslint-disable-next-line no-console
      console.log(`| P90 | ${results.operationTimeStats.p90.toFixed(2)} |`)
      // eslint-disable-next-line no-console
      console.log(`| P99 | ${results.operationTimeStats.p99.toFixed(2)} |`)
    }

    // Display batch statistics
    if (results.batchStats && results.batchStats.length > 0) {
      displayBatchStats(results.batchStats)
    }

    // Display lag histogram
    if (results.allResults && results.allResults.length > 0) {
      displayLagHistogram(results.allResults)
    }

    // Write results to CSV file
    if (results.allResults && results.allResults.length > 0) {
      const csvPath = writeResultsToCSV(results.allResults, csvFilename, results.totalRuns, getLocalnetConfig())
      // eslint-disable-next-line no-console
      console.log(`\n**Results written to:** \`${csvPath}\``)
    }

    if (results.failures.length > 0) {
      // eslint-disable-next-line no-console
      console.log(`\n### Failures\n`)
      results.failures.forEach((failure) => {
        // eslint-disable-next-line no-console
        console.log(`- **Run ${failure.runNumber}:** ${failure.error}`)
      })
    }
  }

  // ==========================================================================
  // CORE TEST INFRASTRUCTURE
  // ==========================================================================
  async function verifyTransactionInIndexer(
    algorand: ReturnType<typeof algorandFixture>['context']['algorand'],
    txId: string,
  ): Promise<boolean> {
    try {
      const txnInfo = await algorand.client.indexer.lookupTransactionByID(txId).do()
      return txnInfo && txnInfo.transaction && txnInfo.transaction.id === txId
    } catch {
      return false
    }
  }

  async function measureIndexerLag(
    algorand: ReturnType<typeof algorandFixture>['context']['algorand'],
    confirmedRound: bigint,
    indexerWaitTimeMs: number,
    indexerPollIntervalMs: number,
    verifyDataAvailable: () => Promise<boolean>,
  ): Promise<number> {
    const indexerStartTime = Date.now()
    let tries = 0
    const maxTries = Math.ceil(indexerWaitTimeMs / indexerPollIntervalMs)

    while (tries < maxTries) {
      try {
        const indexerHealth = await algorand.client.indexer.makeHealthCheck().do()
        const indexerRound = indexerHealth.round

        if (indexerRound >= confirmedRound) {
          if (await verifyDataAvailable()) {
            return Date.now() - indexerStartTime
          }
        }
      } catch (_error) {
        // If health check or verification fails, continue trying
      }

      tries++
      await new Promise((resolve) => setTimeout(resolve, indexerPollIntervalMs))
    }

    // Timeout reached - throw error
    throw new Error('Indexer timeout')
  }

  async function runGenericIndexerLagTest<TSetupContext>(
    numThreads: number,
    totalRounds: number,
    indexerWaitTimeMs: number,
    indexerPollIntervalMs: number,
    setupFn: () => Promise<TSetupContext>,
    singleTestFn: (runNumber: number, threadId: number, context: TSetupContext) => Promise<LoadTestResult>,
  ): Promise<LoadTestSummary> {
    const context = await setupFn()

    // Pre-calculate work distribution to avoid race condition
    // Each thread gets an equal share of rounds, with any remainder distributed to the first threads
    const roundsPerThread = Math.floor(totalRounds / numThreads)
    const extraRounds = totalRounds % numThreads

    // Generic thread runner
    const runThreadTests = async (threadId: number): Promise<LoadTestResult[]> => {
      const results: LoadTestResult[] = []

      // Calculate this thread's range of run numbers
      const myRounds = roundsPerThread + (threadId < extraRounds ? 1 : 0)
      const startRun = threadId * roundsPerThread + Math.min(threadId, extraRounds) + 1

      // Execute assigned rounds
      for (let i = 0; i < myRounds; i++) {
        const runNumber = startRun + i
        const result = await singleTestFn(runNumber, threadId, context)
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

    // Calculate total work time (excluding sleep delays)
    const totalWorkTimeMs = results.filter((r) => r.success && r.workTimeMs !== undefined).reduce((sum, r) => sum + r.workTimeMs!, 0)
    const workDuration = totalWorkTimeMs / 1000

    // Final results
    const successCount = results.filter((r) => r.success).length
    const failureCount = results.filter((r) => !r.success).length
    const successRate = (successCount / totalRounds) * 100

    const failures = results.filter((r) => !r.success)

    // Calculate error counts by error type
    const errorCounts: Record<string, number> = {}
    for (const failure of failures) {
      const errorType = failure.error || 'Unknown error'
      errorCounts[errorType] = (errorCounts[errorType] || 0) + 1
    }

    // Sort results by run number for batch analysis
    const sortedResults = [...results].sort((a, b) => a.runNumber - b.runNumber)

    // Calculate indexer lag statistics for entire run
    const indexerLagStats = calculateIndexerLagStats(sortedResults)

    // Calculate operation time statistics for entire run
    const operationTimeStats = calculateOperationTimeStats(sortedResults)

    // Calculate batch statistics (batches of 500)
    const batchStats = calculateBatchStats(sortedResults, 500)

    return {
      totalRuns: totalRounds,
      successCount,
      failureCount,
      successRate,
      duration: workDuration,
      throughput: totalRounds / workDuration,
      failures,
      allResults: sortedResults,
      errorCounts,
      indexerLagStats,
      operationTimeStats,
      batchStats,
    }
  }

  async function runIndexerLagTest(
    testName: string,
    csvFilename: string,
    runnerFn: (numThreads: number, numRounds: number, waitTime: number, pollInterval: number) => Promise<LoadTestSummary>,
  ) {
    if (!process.env.LOAD_TEST) {
      return
    }

    const numThreads = getNumThreads()
    const numRounds = getNumRounds()
    const indexerWaitTimeMs = getIndexerWaitTimeMs()
    const indexerPollIntervalMs = getIndexerPollIntervalMs()

    const results = await runnerFn(numThreads, numRounds, indexerWaitTimeMs, indexerPollIntervalMs)

    // Basic assertions
    expect(results.totalRuns).toBe(numRounds)
    expect(results.successCount + results.failureCount).toBe(results.totalRuns)
    expect(results.throughput).toBeGreaterThan(0)

    // Display results
    displayIndexerLagTestResults(results, testName, csvFilename, { numThreads, numRounds, indexerWaitTimeMs, indexerPollIntervalMs })
  }

  // ==========================================================================
  // TEST IMPLEMENTATION FUNCTIONS
  // ==========================================================================
  async function runPaymentLoadTest(
    numThreads: number,
    totalRounds: number,
    indexerWaitTimeMs: number,
    indexerPollIntervalMs: number,
  ): Promise<LoadTestSummary> {
    const { algorand, generateAccount } = localnet.context

    return runGenericIndexerLagTest(
      numThreads,
      totalRounds,
      indexerWaitTimeMs,
      indexerPollIntervalMs,
      // Setup function
      async () => {
        const fundingAmount = totalRounds + 1
        const wallets: SigningAccount[] = []
        for (let i = 0; i < numThreads; i++) {
          const wallet = await generateAccount({ initialFunds: (fundingAmount).algo() })
          wallets.push(wallet)
        }
        return { algorand, wallets }
      },
      // Single test function
      async (runNumber, threadId, context) => {
        try {
          const workStartTime = Date.now()
          const sender = context.wallets[threadId]
          const receivers = context.wallets.filter((_, index) => index !== threadId)
          const receiver = receivers[Math.floor(Math.random() * receivers.length)]

          const result = await context.algorand.send.payment({
            sender,
            receiver: receiver.addr,
            amount: (1).algo(),
          })

          const confirmedRound = result.confirmation.confirmedRound!
          const txId = result.txId
          const workTimeMs = Date.now() - workStartTime

          const indexerLagMs = await measureIndexerLag(
            context.algorand,
            confirmedRound,
            indexerWaitTimeMs,
            indexerPollIntervalMs,
            async () => verifyTransactionInIndexer(context.algorand, txId),
          )

          const sleepMs = Math.floor(Math.random() * 991) + 10
          await new Promise((resolve) => setTimeout(resolve, sleepMs))

          return { success: true, runNumber, error: null, indexerLagMs, workTimeMs }
        } catch (error) {
          return { success: false, runNumber, error: error instanceof Error ? error.message : String(error) }
        }
      },
    )
  }

  async function runAssetOptInOptOutLoadTest(
    numThreads: number,
    totalRounds: number,
    indexerWaitTimeMs: number,
    indexerPollIntervalMs: number,
  ): Promise<LoadTestSummary> {
    const { algorand, generateAccount } = localnet.context

    return runGenericIndexerLagTest(
      numThreads,
      totalRounds,
      indexerWaitTimeMs,
      indexerPollIntervalMs,
      // Setup function
      async () => {
        const fundingAmount = 10
        const wallets: SigningAccount[] = []
        const assetIds: bigint[] = []

        for (let i = 0; i < numThreads; i++) {
          const wallet = await generateAccount({ initialFunds: (fundingAmount).algo() })
          wallets.push(wallet)
          const assetId = await generateTestAsset(algorand, wallet, 1000000)
          assetIds.push(assetId)
        }

        const isOptedIn: boolean[] = new Array(numThreads).fill(false)
        return { algorand, wallets, assetIds, isOptedIn }
      },
      // Single test function
      async (runNumber, threadId, context) => {
        try {
          const workStartTime = Date.now()
          const testWallet = context.wallets[threadId]
          const assetCreator = context.wallets[(threadId + 1) % numThreads]
          const assetId = context.assetIds[(threadId + 1) % numThreads]
          const shouldOptIn = !context.isOptedIn[threadId]

          let confirmedRound: bigint

          if (shouldOptIn) {
            const optInResult = await context.algorand.send.assetOptIn({ sender: testWallet, assetId })
            confirmedRound = optInResult.confirmation.confirmedRound!
            const txId = optInResult.txId
            const workTimeMs = Date.now() - workStartTime

            const indexerLagMs = await measureIndexerLag(
              context.algorand,
              confirmedRound,
              indexerWaitTimeMs,
              indexerPollIntervalMs,
              async () => verifyTransactionInIndexer(context.algorand, txId),
            )

            context.isOptedIn[threadId] = true
            const sleepMs = Math.floor(Math.random() * 991) + 10
            await new Promise((resolve) => setTimeout(resolve, sleepMs))

            return { success: true, runNumber, error: null, indexerLagMs, workTimeMs }
          } else {
            const optOutResult = await context.algorand.send.assetOptOut({
              sender: testWallet,
              creator: assetCreator,
              assetId,
              ensureZeroBalance: true,
            })
            confirmedRound = optOutResult.confirmation.confirmedRound!
            const txId = optOutResult.txId
            const workTimeMs = Date.now() - workStartTime

            const indexerLagMs = await measureIndexerLag(
              context.algorand,
              confirmedRound,
              indexerWaitTimeMs,
              indexerPollIntervalMs,
              async () => verifyTransactionInIndexer(context.algorand, txId),
            )

            context.isOptedIn[threadId] = false
            const sleepMs = Math.floor(Math.random() * 991) + 10
            await new Promise((resolve) => setTimeout(resolve, sleepMs))

            return { success: true, runNumber, error: null, indexerLagMs, workTimeMs }
          }
        } catch (error) {
          return { success: false, runNumber, error: error instanceof Error ? error.message : String(error) }
        }
      },
    )
  }

  async function runAssetTransferLoadTest(
    numThreads: number,
    totalRounds: number,
    indexerWaitTimeMs: number,
    indexerPollIntervalMs: number,
  ): Promise<LoadTestSummary> {
    const { algorand, generateAccount } = localnet.context

    return runGenericIndexerLagTest(
      numThreads,
      totalRounds,
      indexerWaitTimeMs,
      indexerPollIntervalMs,
      // Setup function
      async () => {
        const fundingAmount = 10
        const wallets: SigningAccount[] = []
        const assetCreator = await generateAccount({ initialFunds: (10).algo() })
        const sharedAssetId = await generateTestAsset(algorand, assetCreator, 1000000000)

        for (let i = 0; i < numThreads; i++) {
          const wallet = await generateAccount({ initialFunds: (fundingAmount).algo() })
          wallets.push(wallet)
          await algorand.send.assetOptIn({ sender: wallet, assetId: sharedAssetId })
          await algorand.send.assetTransfer({
            sender: assetCreator,
            receiver: wallet.addr,
            assetId: sharedAssetId,
            amount: 100000n,
          })
        }

        return { algorand, wallets, sharedAssetId }
      },
      // Single test function
      async (runNumber, threadId, context) => {
        try {
          const workStartTime = Date.now()
          const sender = context.wallets[threadId]
          const receivers = context.wallets.filter((_, index) => index !== threadId)
          const receiver = receivers[Math.floor(Math.random() * receivers.length)]

          const result = await context.algorand.send.assetTransfer({
            sender,
            receiver: receiver.addr,
            assetId: context.sharedAssetId,
            amount: 1n,
          })

          const confirmedRound = result.confirmation.confirmedRound!
          const txId = result.txId
          const workTimeMs = Date.now() - workStartTime

          const indexerLagMs = await measureIndexerLag(
            context.algorand,
            confirmedRound,
            indexerWaitTimeMs,
            indexerPollIntervalMs,
            async () => verifyTransactionInIndexer(context.algorand, txId),
          )

          const sleepMs = Math.floor(Math.random() * 991) + 10
          await new Promise((resolve) => setTimeout(resolve, sleepMs))

          return { success: true, runNumber, error: null, indexerLagMs, workTimeMs }
        } catch (error) {
          return { success: false, runNumber, error: error instanceof Error ? error.message : String(error) }
        }
      },
    )
  }

  async function runAppCreateLoadTest(
    numThreads: number,
    totalRounds: number,
    indexerWaitTimeMs: number,
    indexerPollIntervalMs: number,
  ): Promise<LoadTestSummary> {
    const { algorand, generateAccount } = localnet.context

    return runGenericIndexerLagTest(
      numThreads,
      totalRounds,
      indexerWaitTimeMs,
      indexerPollIntervalMs,
      // Setup function: create wallets with funding
      async () => {
        const fundingAmount = 100 // Enough for app creation fees
        const wallets: SigningAccount[] = []
        for (let i = 0; i < numThreads; i++) {
          const wallet = await generateAccount({ initialFunds: fundingAmount.algo() })
          wallets.push(wallet)
        }
        return { algorand, wallets }
      },
      // Single test function: create app and measure indexer lag
      async (runNumber, threadId, context) => {
        try {
          const workStartTime = Date.now()
          const sender = context.wallets[threadId]

          // Minimal approval program that just approves all transactions
          const approvalProgram = `#pragma version 10
int 1
return`

          // Minimal clear state program that just approves
          const clearStateProgram = `#pragma version 10
int 1
return`

          const result = await context.algorand.send.appCreate({
            sender,
            approvalProgram,
            clearStateProgram,
            schema: {
              globalInts: 0,
              globalByteSlices: 0,
              localInts: 0,
              localByteSlices: 0,
            },
          })

          const appId = result.appId
          const confirmedRound = result.confirmation.confirmedRound!
          const workTimeMs = Date.now() - workStartTime

          // Measure indexer lag with timeout = failure behavior
          const indexerLagMs = await measureIndexerLag(
            context.algorand,
            confirmedRound,
            indexerWaitTimeMs,
            indexerPollIntervalMs,
            async () => {
              // Verify the app is queryable through indexer
              try {
                const appInfo = await context.algorand.client.indexer.lookupApplications(Number(appId)).do()
                return appInfo && appInfo.application && appInfo.application.id === Number(appId)
              } catch {
                return false
              }
            },
          )

          const sleepMs = Math.floor(Math.random() * 991) + 10
          await new Promise((resolve) => setTimeout(resolve, sleepMs))

          return { success: true, runNumber, error: null, indexerLagMs, workTimeMs }
        } catch (error) {
          return { success: false, runNumber, error: error instanceof Error ? error.message : String(error) }
        }
      },
    )
  }

  async function runAssetCreateLoadTest(
    numThreads: number,
    totalRounds: number,
    indexerWaitTimeMs: number,
    indexerPollIntervalMs: number,
  ): Promise<LoadTestSummary> {
    const { algorand, generateAccount } = localnet.context

    return runGenericIndexerLagTest(
      numThreads,
      totalRounds,
      indexerWaitTimeMs,
      indexerPollIntervalMs,
      // Setup function: create wallets with funding
      async () => {
        const fundingAmount = 100 // Enough for asset creation operations and fees
        const wallets: SigningAccount[] = []
        for (let i = 0; i < numThreads; i++) {
          const wallet = await generateAccount({ initialFunds: fundingAmount.algo() })
          wallets.push(wallet)
        }
        return { algorand, wallets }
      },
      // Single test function: create asset and measure indexer lag
      async (runNumber, threadId, context) => {
        try {
          const workStartTime = Date.now()
          const creator = context.wallets[threadId]

          // Create asset with unique unit name based on run number
          const assetCreateResult = await context.algorand.send.assetCreate({
            sender: creator,
            total: 1000000n,
            decimals: 0,
            assetName: `Asset${runNumber}`,
            unitName: `A${runNumber}`,
          })

          const confirmedRound = assetCreateResult.confirmation.confirmedRound!
          const assetId = assetCreateResult.assetId
          const workTimeMs = Date.now() - workStartTime

          // Measure indexer lag with timeout = failure behavior
          const indexerLagMs = await measureIndexerLag(
            context.algorand,
            confirmedRound,
            indexerWaitTimeMs,
            indexerPollIntervalMs,
            async () => {
              // Verify the asset is queryable through indexer
              try {
                const assetInfo = await context.algorand.client.indexer.lookupAssetByID(Number(assetId)).do()
                return assetInfo && assetInfo.asset && assetInfo.asset.index === Number(assetId)
              } catch {
                return false
              }
            },
          )

          const sleepMs = Math.floor(Math.random() * 991) + 10
          await new Promise((resolve) => setTimeout(resolve, sleepMs))

          return { success: true, runNumber, error: null, indexerLagMs, workTimeMs }
        } catch (error) {
          return { success: false, runNumber, error: error instanceof Error ? error.message : String(error) }
        }
      },
    )
  }

  async function runAppCallLoadTest(
    numThreads: number,
    totalRounds: number,
    indexerWaitTimeMs: number,
    indexerPollIntervalMs: number,
  ): Promise<LoadTestSummary> {
    const { algorand, generateAccount } = localnet.context

    return runGenericIndexerLagTest(
      numThreads,
      totalRounds,
      indexerWaitTimeMs,
      indexerPollIntervalMs,
      // Setup function: create wallets and deploy one app per thread
      async () => {
        const fundingAmount = 50 // Enough for app calls and fees
        const wallets: SigningAccount[] = []
        const appIds: bigint[] = []

        for (let i = 0; i < numThreads; i++) {
          const wallet = await generateAccount({ initialFunds: fundingAmount.algo() })
          wallets.push(wallet)

          // Deploy a simple app for this thread
          const app = await algorand.send.appCreate({
            sender: wallet,
            approvalProgram: '#pragma version 10\nint 1\nreturn',
            clearStateProgram: '#pragma version 10\nint 1\nreturn',
          })
          appIds.push(app.appId)
        }
        return { algorand, wallets, appIds }
      },
      // Single test function: call app and measure indexer lag
      async (runNumber, threadId, context) => {
        try {
          const workStartTime = Date.now()
          const caller = context.wallets[threadId]
          const appId = context.appIds[threadId]

          // Call the app (NoOp)
          const appCallResult = await context.algorand.send.appCall({
            sender: caller,
            appId,
          })

          const confirmedRound = appCallResult.confirmation.confirmedRound!
          const txId = appCallResult.txId
          const workTimeMs = Date.now() - workStartTime

          // Measure indexer lag with timeout = failure behavior
          const indexerLagMs = await measureIndexerLag(
            context.algorand,
            confirmedRound,
            indexerWaitTimeMs,
            indexerPollIntervalMs,
            async () => verifyTransactionInIndexer(context.algorand, txId),
          )

          const sleepMs = Math.floor(Math.random() * 991) + 10
          await new Promise((resolve) => setTimeout(resolve, sleepMs))

          return { success: true, runNumber, error: null, indexerLagMs, workTimeMs }
        } catch (error) {
          return { success: false, runNumber, error: error instanceof Error ? error.message : String(error) }
        }
      },
    )
  }

  async function runAppUpdateLoadTest(
    numThreads: number,
    totalRounds: number,
    indexerWaitTimeMs: number,
    indexerPollIntervalMs: number,
  ): Promise<LoadTestSummary> {
    const { algorand, generateAccount } = localnet.context

    return runGenericIndexerLagTest(
      numThreads,
      totalRounds,
      indexerWaitTimeMs,
      indexerPollIntervalMs,
      // Setup function: create wallets and deploy one updatable app per thread
      async () => {
        const fundingAmount = 50 // Enough for app updates and fees
        const wallets: SigningAccount[] = []
        const appIds: bigint[] = []

        for (let i = 0; i < numThreads; i++) {
          const wallet = await generateAccount({ initialFunds: fundingAmount.algo() })
          wallets.push(wallet)

          // Deploy an updatable app for this thread
          const app = await algorand.send.appCreate({
            sender: wallet,
            approvalProgram: '#pragma version 10\nint 1\nreturn',
            clearStateProgram: '#pragma version 10\nint 1\nreturn',
          })
          appIds.push(app.appId)
        }
        return { algorand, wallets, appIds }
      },
      // Single test function: update app and measure indexer lag
      async (runNumber, threadId, context) => {
        try {
          const workStartTime = Date.now()
          const updater = context.wallets[threadId]
          const appId = context.appIds[threadId]

          // Update the app with a slightly different program (toggle between two versions)
          const programVariant = runNumber % 2 === 0 ? 'int 1\nreturn' : 'int 1\n// updated\nreturn'
          const appUpdateResult = await context.algorand.send.appUpdate({
            sender: updater,
            appId,
            approvalProgram: `#pragma version 10\n${programVariant}`,
            clearStateProgram: '#pragma version 10\nint 1\nreturn',
          })

          const confirmedRound = appUpdateResult.confirmation.confirmedRound!
          const txId = appUpdateResult.txId
          const workTimeMs = Date.now() - workStartTime

          // Measure indexer lag with timeout = failure behavior
          const indexerLagMs = await measureIndexerLag(
            context.algorand,
            confirmedRound,
            indexerWaitTimeMs,
            indexerPollIntervalMs,
            async () => verifyTransactionInIndexer(context.algorand, txId),
          )

          const sleepMs = Math.floor(Math.random() * 991) + 10
          await new Promise((resolve) => setTimeout(resolve, sleepMs))

          return { success: true, runNumber, error: null, indexerLagMs, workTimeMs }
        } catch (error) {
          return { success: false, runNumber, error: error instanceof Error ? error.message : String(error) }
        }
      },
    )
  }

  async function runAppDeleteLoadTest(
    numThreads: number,
    totalRounds: number,
    indexerWaitTimeMs: number,
    indexerPollIntervalMs: number,
  ): Promise<LoadTestSummary> {
    const { algorand, generateAccount } = localnet.context

    return runGenericIndexerLagTest(
      numThreads,
      totalRounds,
      indexerWaitTimeMs,
      indexerPollIntervalMs,
      // Setup function: create wallets with funding
      async () => {
        const fundingAmount = 100 // Enough for creating and deleting many apps
        const wallets: SigningAccount[] = []
        for (let i = 0; i < numThreads; i++) {
          const wallet = await generateAccount({ initialFunds: fundingAmount.algo() })
          wallets.push(wallet)
        }
        return { algorand, wallets }
      },
      // Single test function: create and delete app, then measure indexer lag
      async (runNumber, threadId, context) => {
        try {
          const creator = context.wallets[threadId]

          // First create an app to delete (not included in workTimeMs)
          const app = await context.algorand.send.appCreate({
            sender: creator,
            approvalProgram: '#pragma version 10\nint 1\nreturn',
            clearStateProgram: '#pragma version 10\nint 1\nreturn',
          })
          const appId = app.appId

          // Start work timer for delete operation only
          const workStartTime = Date.now()

          // Delete the app
          const appDeleteResult = await context.algorand.send.appDelete({
            sender: creator,
            appId,
          })

          const confirmedRound = appDeleteResult.confirmation.confirmedRound!
          const txId = appDeleteResult.txId
          const workTimeMs = Date.now() - workStartTime

          // Measure indexer lag with timeout = failure behavior
          const indexerLagMs = await measureIndexerLag(
            context.algorand,
            confirmedRound,
            indexerWaitTimeMs,
            indexerPollIntervalMs,
            async () => verifyTransactionInIndexer(context.algorand, txId),
          )

          const sleepMs = Math.floor(Math.random() * 991) + 10
          await new Promise((resolve) => setTimeout(resolve, sleepMs))

          return { success: true, runNumber, error: null, indexerLagMs, workTimeMs }
        } catch (error) {
          return { success: false, runNumber, error: error instanceof Error ? error.message : String(error) }
        }
      },
    )
  }

  // ==========================================================================
  // TEST DECLARATIONS
  // ==========================================================================
  test(
    'perf_payment_indexer_lag',
    async () => {
      await runIndexerLagTest('Payment Indexer Lag', 'payment-indexer-lag', runPaymentLoadTest)
    },
    getLoadTestTimeout(),
  )

  test(
    'perf_asset_optin_optout_indexer_lag',
    async () => {
      await runIndexerLagTest('Asset Opt-In/Opt-Out Indexer Lag', 'asset-optin-optout-indexer-lag', runAssetOptInOptOutLoadTest)
    },
    getLoadTestTimeout(),
  )

  test(
    'perf_asset_transfer_indexer_lag',
    async () => {
      await runIndexerLagTest('Asset Transfer Indexer Lag', 'asset-transfer-indexer-lag', runAssetTransferLoadTest)
    },
    getLoadTestTimeout(),
  )

  test(
    'perf_app_create_indexer_lag',
    async () => {
      await runIndexerLagTest('App Create Indexer Lag', 'app-create-indexer-lag', runAppCreateLoadTest)
    },
    getLoadTestTimeout(),
  )

  test(
    'perf_asset_create_indexer_lag',
    async () => {
      await runIndexerLagTest('Asset Create Indexer Lag', 'asset-create-indexer-lag', runAssetCreateLoadTest)
    },
    getLoadTestTimeout(),
  )

  test(
    'perf_app_call_indexer_lag',
    async () => {
      await runIndexerLagTest('App Call Indexer Lag', 'app-call-indexer-lag', runAppCallLoadTest)
    },
    getLoadTestTimeout(),
  )

  test(
    'perf_app_update_indexer_lag',
    async () => {
      await runIndexerLagTest('App Update Indexer Lag', 'app-update-indexer-lag', runAppUpdateLoadTest)
    },
    getLoadTestTimeout(),
  )

  test(
    'perf_app_delete_indexer_lag',
    async () => {
      await runIndexerLagTest('App Delete Indexer Lag', 'app-delete-indexer-lag', runAppDeleteLoadTest)
    },
    getLoadTestTimeout(),
  )
})
