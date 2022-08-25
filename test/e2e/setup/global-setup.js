const { chromium } = require('@playwright/test')
const path = require('path')
const fs = require('fs')
// const v8toIstanbul = require('v8-to-istanbul')

module.exports = async config => {
  // Read and expose backend info in env availables inside of test() blocks
  const { rpcAddr, id, agentVersion } = JSON.parse(fs.readFileSync(path.join(__dirname, 'ipfs-backend.json')))
  process.env.IPFS_RPC_ADDR = rpcAddr
  process.env.IPFS_RPC_ID = id
  process.env.IPFS_RPC_VERSION = agentVersion

  // Set and save RPC API endpoint in storageState, so test start against
  // desired endpoint
  const { baseURL, storageState } = config.projects[0].use
  const browser = await chromium.launch()
  const page = await browser.newPage()
  // await page.coverage.startJSCoverage()
  await page.goto(baseURL)
  // const coverage = await page.coverage.stopJSCoverage()
  // for (const entry of coverage) {
  //   const converter = v8toIstanbul('', 0, { source: entry.source })
  //   await converter.load()
  //   converter.applyCoverage(entry.functions)
  //   console.log(JSON.stringify(converter.toIstanbul()))
  // }
  await page.evaluate(`localStorage.setItem("ipfsApi", "${rpcAddr}")`)
  await page.context().storageState({ path: storageState })
  await browser.close()
}
