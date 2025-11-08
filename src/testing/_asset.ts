import { Address } from 'algosdk'
import { AlgorandClient } from '../types/algorand-client'

export async function generateTestAsset(algorand: AlgorandClient, sender: Address | string, total?: number) {
  total = !total ? Math.floor(Math.random() * 100) + 20 : total
  const decimals = 0
  const assetName = `ASA ${Math.floor(Math.random() * 100) + 1}_${Math.floor(Math.random() * 100) + 1}_${total}`

  const asset = await algorand.send.assetCreate({
    sender: sender,
    total: BigInt(total * 10 ** decimals),
    decimals: decimals,
    defaultFrozen: false,
    unitName: '',
    assetName: assetName,
    manager: sender,
    reserve: sender,
    freeze: sender,
    clawback: sender,
    url: 'https://path/to/my/asset/details',
  })

  return asset.assetId
}

export async function generateTestApp(algorand: AlgorandClient, sender: Address | string) {
  // Minimal approval program that just approves all transactions
  const approvalProgram = `#pragma version 8
int 1
return`

  // Minimal clear state program that just approves
  const clearStateProgram = `#pragma version 8
int 1
return`

  const app = await algorand.send.appCreate({
    sender: sender,
    approvalProgram,
    clearStateProgram,
    schema: {
      globalInts: 0,
      globalByteSlices: 0,
      localInts: 0,
      localByteSlices: 0,
    },
  })

  return app.appId
}
