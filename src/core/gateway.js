const sandboxHelper = require('../utils/sandbox.js')
const slots = require('../utils/slots.js')
const Router = require('../utils/router.js')
const PIFY = require('../utils/pify.js')
const utils = require('../utils')
const gatewayLib = require('asch-gateway')

const AschCore = require('asch-smartdb').AschCore

var modules, library, self, private = {}, shared = {};

private.version, private.osName, private.port;

const GatewayLogType = {
  IMPORT_ADDRESS: 1,
  DEPOSIT: 2,
  WITHDRAWAL: 3,
  SEND_WITHDRAWAL: 4
}

async function getGatewayAccountByOutAddress(addresses, coldAccount) {
  let accountMap = {}
  for (let i of addresses) {
    let account
    if (coldAccount.address === i) {
      account = coldAccount.accountExtrsInfo.redeemScript
    } else {
      let gatewayAccount = await app.sdb.findOne('GatewayAccount', { condition: { outAddress: i } })
      if (!gatewayAccount) throw new Error('Input address have no gateway account')
      account = JSON.parse(gatewayAccount.attachment).redeemScript
    }
    accountMap[i] = account
  }
  return accountMap
}

function Gateway(cb, scope) {
  library = scope;
  self = this;
  self.__private = private;

  setImmediate(cb, null, self);
}

Gateway.prototype.importAccounts = async function () {
  const GATEWAY = global.Config.gateway.name
  if (modules.loader.syncing() || !GATEWAY) {
    return
  }
  const key = app.sdb.getEntityKey('GatewayLog', { gateway: GATEWAY, type: GatewayLogType.IMPORT_ADDRESS })
  let lastImportAddressLog = app.sdb.getCached('GatewayLog', key)

  library.logger.debug('find last import address log', lastImportAddressLog)
  let lastSeq = 0
  if (lastImportAddressLog) {
    lastSeq = lastImportAddressLog.seq
  } else {
    lastImportAddressLog = app.sdb.create('GatewayLog', { gateway: GATEWAY, type: GatewayLogType.IMPORT_ADDRESS, seq: 0 })
  }
  //query( model, condition, fields, limit, offset, sort, join )
  let gatewayAccounts = await app.sdb.find('GatewayAccount', { gateway: GATEWAY, seq: { $gt: lastSeq } }, 100, { seq: 1 })
  library.logger.debug('find gateway account', gatewayAccounts)
  let len = gatewayAccounts.length
  if (len > 0) {
    for (let a of gatewayAccounts) {
      await PIFY(gatewayLib.bitcoin.importAddress)(a.outAddress)
    }

    lastImportAddressLog.seq = gatewayAccounts[len - 1].seq
    app.sdb.saveLocalChanges()
  }
}

Gateway.prototype.processDeposits = async function () {
  const GATEWAY = global.Config.gateway.name
  if (modules.loader.syncing() || !GATEWAY) {
    return
  }
  const CURRENCY = 'BTC'

  let validators = await app.sdb.findAll('GatewayMember', { gateway: GATEWAY, elected: 1 })
  if (!validators || !validators.length) {
    library.logger.error('Validators not found')
    return
  }

  if (await app.sdb.count('GatewayAccount', { gateway: GATEWAY }) == 0) {
    library.logger.error('No gateway accounts')
    return
  }

  const gatewayLogKey = app.sdb.getEntityKey('GatewayLog', { gateway: GATEWAY, type: GatewayLogType.DEPOSIT })
  let lastDepositLog = app.sdb.getCached('GatewayLog', gatewayLogKey)
  library.logger.debug('==========find DEPOSIT log============', lastDepositLog)

  lastDepositLog = lastDepositLog ||
    app.sdb.create('GatewayLog', { gateway: GATEWAY, type: GatewayLogType.DEPOSIT, seq: 0 })

  let lastSeq = lastDepositLog.seq
  let ret = await PIFY(gatewayLib.bitcoin.getTransactionsFromBlockHeight)(lastSeq)
  if (!ret || !ret.transactions) {
    library.logger.error('Failed to get gateway transactions')
    return
  }

  let outTransactions = ret.transactions.filter(ot => ot.category === 'receive' && ot.confirmations >= 1)
    .sort((l, r) => l.height - r.height)

  library.logger.debug('get gateway transactions', outTransactions)
  let len = outTransactions.length
  if (len > 0) {
    for (let ot of outTransactions) {
      let isAccountOpened = await app.sdb.exists('GatewayAccount', { outAddress: ot.address })
      if (!isAccountOpened) {
        library.logger.warn('unknow address', { address: ot.address, gateway: GATEWAY, t: ot })
        continue
      }

      async function processDeposit() {
        const params = {
          type: 402,
          secret: global.Config.gateway.secret,
          fee: 10000000,
          args: [GATEWAY, ot.address, CURRENCY, String(ot.amount * 100000000), ot.txid]
        }
        await PIFY(modules.transactions.addTransactionUnsigned)(params)
      }
      const onError = function (err) {
        library.logger.error('process gateway deposit error, will retry...', err)
      }
      try {
        await utils.retryAsync(processDeposit, 3, 10 * 1000, onError)
        library.logger.info('Gateway deposit processed', { address: ot.address, amount: ot.amount, gateway: GATEWAY })
      } catch (e) {
        library.logger.warn('Failed to process gateway deposit', {error: e, outTransaction: ot})
      }
    }
    lastDepositLog.seq = outTransactions[len - 1].height
    app.sdb.saveLocalChanges()
  }
}

Gateway.prototype.processWithdrawals = async function () {
  const GATEWAY = global.Config.gateway.name
  if (modules.loader.syncing() || !GATEWAY) {
    return
  }
  let PAGE_SIZE = 25
  let validators = await app.sdb.findAll('GatewayMember', { gateway: GATEWAY, elected: 1 })
  if (!validators || !validators.length) {
    library.logger.error('Validators not found')
    return
  }
  library.logger.debug('find gateway validators', validators)

  let outPublicKeys = validators.map((v) => v.outPublicKey).sort((l, r) => l - r)
  let unlockNumber = Math.floor(outPublicKeys.length / 2) + 1
  let multiAccount = app.gateway.createMultisigAddress(GATEWAY, unlockNumber, outPublicKeys, true)
  library.logger.debug('gateway validators cold account', multiAccount)

  let withdrawalLogKey = app.sdb.getEntityKey('GatewayLog', { gateway: GATEWAY, type: GatewayLogType.WITHDRAWAL })
  let lastWithdrawalLog = await app.sdb.get('GatewayLog', withdrawalLogKey)
  library.logger.debug('find ==========WITHDRAWAL============ log', lastWithdrawalLog)

  lastWithdrawalLog = lastWithdrawalLog ||
    app.sdb.create('GatewayLog', { gateway: GATEWAY, type: GatewayLogType.WITHDRAWAL, seq: 0 })

  let lastSeq = lastWithdrawalLog.seq

  let withdrawals = await app.sdb.find('GatewayWithdrawal', { gateway: GATEWAY, seq: { $gt: lastSeq } }, PAGE_SIZE)
  library.logger.debug('get gateway withdrawals', withdrawals)
  if (!withdrawals || !withdrawals.length) {
    return
  }

  let account = {
    privateKey: global.Config.gateway.outSecret
  }
  for (let w of withdrawals) {
    async function processWithdrawal() {
      let contractParams = null
      w = await app.sdb.get('GatewayWithdrawal', w.tid)
      if (!w.outTransaction) {
        let output = [{ address: w.recipientId, value: Number(w.amount) }]
        let ot = await PIFY(gatewayLib.bitcoin.createNewTransaction)(multiAccount, output)
        library.logger.debug('create withdrawl out transaction', ot)

        let inputAccountInfo = await getGatewayAccountByOutAddress(ot.input, multiAccount)
        library.logger.debug('input account info', inputAccountInfo)

        let ots = gatewayLib.bitcoin.signTransaction(ot, account, inputAccountInfo)
        library.logger.debug('sign withdrawl out transaction', ots)

        contractParams = {
          type: 404,
          secret: global.Config.gateway.secret,
          fee: 10000000,
          args: [w.tid, JSON.stringify(ot), JSON.stringify(ots)]
        }
      } else {
        let ot = JSON.parse(w.outTransaction)
        let inputAccountInfo = await getGatewayAccountByOutAddress(ot.input, multiAccount)
        let ots = gatewayLib.bitcoin.signTransaction(ot, account, inputAccountInfo)
        contractParams = {
          type: 405,
          secret: global.Config.gateway.secret,
          fee: 10000000,
          args: [w.tid, JSON.stringify(ots)]
        }
      }
      await PIFY(modules.transactions.addTransactionUnsigned)(contractParams)
    }
    const onError = function (err) {
      library.logger.error('Process gateway withdrawal error, will retry', err)
    }
    try {
      await utils.retryAsync(processWithdrawal, 3, 10 * 1000, onError)
      library.logger.info('Gateway withdrawal processed', { wid: w.tid, type: contractParams.type })
    } catch (e) {
      library.logger.warn('Failed to process gateway withdrawal', { error: e, transaction: w })
    }
  }
  lastWithdrawalLog.seq = withdrawals[withdrawals.length - 1].seq
  app.sdb.saveLocalChanges()
}

Gateway.prototype.sendWithdrawals = async function () {
  const GATEWAY = global.Config.gateway.name
  if (modules.loader.syncing() || !GATEWAY) {
    return
  }
  const PAGE_SIZE = 25
  let lastSeq = 0
  let logKey = app.sdb.getEntityKey('GatewayLog', {
    gateway: GATEWAY,
    type: GatewayLogType.SEND_WITHDRAWAL
  })
  let lastLog = app.sdb.getCached('GatewayLog', logKey)
  library.logger.debug('find ======SEND_WITHDRAWAL====== log', lastLog)
  if (lastLog) {
    lastSeq = lastLog.seq
  } else {
    lastLog = app.sdb.create('GatewayLog', { gateway: GATEWAY, type: GatewayLogType.SEND_WITHDRAWAL, seq: 0 })
  }
  let withdrawals = await app.sdb.findAll('GatewayWithdrawal', {
    condition: {
      gateway: GATEWAY,
      seq: { $gt: lastSeq }
    },
    limit: PAGE_SIZE,
    sort: {
      seq: 1
    }
  })
  library.logger.debug('get gateway withdrawals', withdrawals)
  if (!withdrawals || !withdrawals.length) {
    return
  }
  let validators = await app.sdb.findAll('GatewayMember', {
    condition: {
      gateway: GATEWAY,
      elected: 1
    }
  })
  if (!validators) {
    library.logger.error('Validators not found')
    return
  }
  library.logger.debug('find gateway validators', validators)

  let outPublicKeys = validators.map((v) => v.outPublicKey).sort((l, r) => l - r)
  let unlockNumber = Math.floor(outPublicKeys.length / 2) + 1
  let multiAccount = app.gateway.createMultisigAddress(GATEWAY, unlockNumber, outPublicKeys, true)
  library.logger.debug('gateway validators cold account', multiAccount)

  for (let w of withdrawals) {
    if (!w.outTransaction) {
      library.logger.debug('out transaction not created')
      continue
    }
    let preps = await app.sdb.findAll('GatewayWithdrawalPrep', { condition: { wid: w.tid } })
    if (preps.length < unlockNumber) {
      library.logger.debug('not enough signature')
      return
    }
    let ot = JSON.parse(w.outTransaction)
    let ots = []
    for (let i = 0; i < unlockNumber; i++) {
      ots.push(JSON.parse(preps[i].signature))
    }

    async function sendWithdrawal() {
      let inputAccountInfo = await getGatewayAccountByOutAddress(ot.input, multiAccount)
      library.logger.debug('before build transaction')
      let finalTransaction = gatewayLib.bitcoin.buildTransaction(ot, ots, inputAccountInfo)
      library.logger.debug('before send raw tarnsaction', finalTransaction)
      let ret = await PIFY(gatewayLib.bitcoin.sendRawTransaction)(finalTransaction)
      return ret
    }
    const onError = function (err) {
      library.logger.error('Send withdrawal error, will retry...', err)
    }
    try {
      const ret = await utils.retryAsync(sendWithdrawal, 3, 10 * 1000)
      library.logger.info('Send withdrawal transaction to out chain success', ret)
    } catch (e) {
      library.logger.error('Failed to send gateway withdrawal', { error: e, transaction: w })
    }
  }
  let len = withdrawals.length
  lastLog.seq = withdrawals[len - 1].seq
}

Gateway.prototype.onBlockchainReady = function () {
  if (global.Config.gateway) {
    utils.loopAsyncFunction(self.importAccounts.bind(self), 10 * 1000)
    utils.loopAsyncFunction(self.processDeposits.bind(self), 60 * 1000)
    utils.loopAsyncFunction(self.processWithdrawals.bind(self), 10 * 1000)
    if (global.Config.gateway.sendWithdrawal) {
      utils.loopAsyncFunction(self.sendWithdrawals.bind(self), 30 * 1000)
    }
  }
}

Gateway.prototype.onBind = function (scope) {
  modules = scope;
}

module.exports = Gateway;