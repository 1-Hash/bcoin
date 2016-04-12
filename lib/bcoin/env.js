/**
 * env.js - environment for bcoin
 * Copyright (c) 2014-2015, Fedor Indutny (MIT License).
 * Copyright (c) 2014-2016, Christopher Jeffrey (MIT License).
 * https://github.com/indutny/bcoin
 */

var utils = require('./utils');
var assert = utils.assert;
var fs;

try {
  fs = require('f' + 's');
} catch (e) {
  ;
}

/**
 * A BCoin "environment" which is tied to the
 * network type among other options. It exposes all
 * constructors for primitives, the blockchain,
 * mempool, wallet, etc. BCoin is _not_ usable
 * without an environment.
 *
 * @exports Environment
 * @constructor
 *
 * @param {Object|String} options - Options object or network type.
 * @param {String?} options.network - One of `main`, `testnet`,
 * `regtest`, `segnet3`, `segnet4`.
 * @param {String?} options.prefix - Prefix for filesystem (default=~/.bcoin).
 * @param {String?} options.db - Database backend (default=leveldb).
 * @param {Boolean?} options.debug - Whether to display debug output.
 * @param {(String|Boolean)?} options.debugFile - A file to
 * pipe debug output to.
 * @param {Boolean?} options.profile - Enable profiler.
 * @param {Boolean?} options.useWorkers - Enable workers.
 * @param {Number?} options.maxWorkers - Max size of
 * the worker pool (default=6).
 *
 * @property {Boolean} isBrowser
 * @property {String} networkType
 *
 * @property {Function} bn - Big number constructor
 * (see {@link https://github.com/indutny/bn.js} for docs).
 * @property {Object} utils - {@link utils}.
 * @property {Function} locker - {@link Locker} constructor.
 * @property {Function} reader - {@link BufferReader} constructor.
 * @property {Function} writer - {@link BufferWriter} constructor.
 * @property {Object} ec - {@link ec}.
 * @property {Function} lru - {@link LRU} constructor.
 * @property {Function} bloom - {@link Bloom} constructor.
 * @property {Function} bst - {@link BST} constructor.
 * @property {Function} lowlevelup - See {@link LowlevelUp}.
 *
 * @property {Object} protocol
 * @property {Function} protocol.constants - See {@link constants}.
 * @property {Function} protocol.network - See {@link network}.
 * @property {Function} protocol.framer - {@link Framer} constructor.
 * @property {Function} protocol.parser - {@link Parser} constructor.
 * @property {Function} profiler - {@link Profiler} constructor.
 * @property {Function} ldb - See {@link ldb}.
 * @property {Function} script - {@link Script} constructor.
 * @property {Function} stack - {@link Stack} constructor.
 * @property {Function} witness - {@link Witness} constructor.
 * @property {Function} input - {@link Input} constructor.
 * @property {Function} output - {@link Output} constructor.
 * @property {Function} coin - {@link Coin} constructor.
 * @property {Function} coins - {@link Coins} constructor.
 * @property {Function} coinview - {@link CoinView} constructor.
 * @property {Function} tx - {@link TX} constructor.
 * @property {Function} mtx - {@link MTX} constructor.
 * @property {Function} txdb - {@link TXDB} constructor.
 * @property {Function} abstractblock - {@link AbstractBlock} constructor.
 * @property {Function} compactblock - {@link CompactBlock} constructor.
 * @property {Function} block - {@link Block} constructor.
 * @property {Function} merkleblock - {@link MerkleBlock} constructor.
 * @property {Function} headers - {@link Headers} constructor.
 * @property {Function} node - {@link Node} constructor.
 * @property {Function} spvnode - {@link SPVNode} constructor.
 * @property {Function} fullnode - {@link Fullnode} constructor.
 * @property {Function} chainblock - {@link ChainBlock} constructor.
 * @property {Function} chaindb - {@link ChainDB} constructor.
 * @property {Function} chain - {@link Chain} constructor.
 * @property {Function} mempool - {@link Mempool} constructor.
 * @property {Function} keypair - {@link KeyPair} constructor.
 * @property {Function} hd - {@link HD} constructor.
 * @property {Function} address - {@link Address} constructor.
 * @property {Function} wallet - {@link Wallet} constructor.
 * @property {Function} walletdb - {@link WalletDB} constructor.
 * @property {Function} provider - {@link Provider} constructor.
 * @property {Function} peer - {@link Peer} constructor.
 * @property {Function} pool - {@link Pool} constructor.
 * @property {Function} miner - {@link Miner} constructor.
 * @property {Function} minerblock - {@link MinerBlock} constructor.
 * @property {Object} http
 * @property {Function} http.client - {@link Client} constructor.
 * @property {Function} http.http - {@link HTTPServer} constructor.
 * @property {Function} http.provider - {@link HTTPProvider} constructor.
 * @property {Function} http.request - See {@link request}.
 * @property {Function} http.server - {@link NodeServer} constructor.
 * @property {Object} workers - See {@link workers}.
 */

function Environment(options) {
  if (!(this instanceof Environment))
    return new Environment(options);

  if (!options)
    options = {};

  if (typeof options === 'string')
    options = { network: options };

  this.options = options;

  this._ensured = false;
  this._debug = null;

  this.isBrowser =
    (typeof process !== 'undefined' && process.browser)
    || typeof window !== 'undefined';

  this.prefix = process.env.BCOIN_PREFIX
    || options.prefix
    || process.env.HOME + '/.bcoin';

  this.db = options.db;

  if (process.env.BCOIN_DB != null)
    this.db = process.env.BCOIN_DB;

  this.debugLogs = options.debug;

  if (process.env.BCOIN_DEBUG != null)
    this.debugLogs = +process.env.BCOIN_DEBUG === 1;

  this.debugFile = options.debugFile;

  if (process.env.BCOIN_DEBUGFILE != null) {
    if (process.env.BCOIN_DEBUGFILE === '0'
        || process.env.BCOIN_DEBUGFILE === '1') {
      this.debugFile = +process.env.BCOIN_DEBUGFILE !== 0;
    } else {
      this.debugFile = process.env.BCOIN_DEBUGFILE;
    }
  }

  if (this.debugFile && typeof this.debugFile !== 'string')
    this.debugFile = this.prefix + '/debug.log'

  this.profile = options.profile;

  if (process.env.BCOIN_PROFILE != null)
    this.profile = +process.env.BCOIN_PROFILE === 1;

  this.useWorkers = options.useWorkers;

  if (process.env.BCOIN_USE_WORKERS != null)
    this.useWorkers = +process.env.BCOIN_USE_WORKERS === 1;

  this.useWorkers = options.maxWorkers;

  if (process.env.BCOIN_MAX_WORKERS != null)
    this.maxWorkers = +process.env.BCOIN_MAX_WORKERS;

  this.workerTimeout = options.workerTimeout;

  if (process.env.BCOIN_WORKER_TIMEOUT != null)
    this.workerTimeout = +process.env.BCOIN_WORKER_TIMEOUT;

  this.networkType = process.env.BCOIN_NETWORK
    || options.network
    || 'main';

  this.bn = require('bn.js');
  this.utils = require('./utils');
  this.locker = require('./locker');
  this.reader = require('./reader');
  this.writer = require('./writer');
  this.ec = require('./ec');
  this.lru = require('./lru');
  this.bloom = require('./bloom');
  this.bst = require('./bst');
  this.lowlevelup = require('./lowlevelup');

  this.protocol = require('./protocol')(this);
  this.profiler = require('./profiler')(this);
  this.ldb = require('./ldb')(this);
  this.script = require('./script')(this);
  this.stack = this.script.stack;
  this.witness = this.script.witness;
  this.input = require('./input')(this);
  this.output = require('./output')(this);
  this.coin = require('./coin')(this);
  this.coins = require('./coins')(this);
  this.coinview = require('./coinview')(this);
  this.tx = require('./tx')(this);
  this.transaction = this.tx;
  this.mtx = require('./mtx')(this);
  this.mutabletransaction = this.mtx;
  this.txdb = require('./txdb')(this);
  this.abstractblock = require('./abstractblock')(this);
  this.compactblock = require('./compactblock')(this);
  this.block = require('./block')(this);
  this.merkleblock = require('./merkleblock')(this);
  this.headers = require('./headers')(this);
  this.node = require('./node')(this);
  this.spvnode = require('./spvnode')(this);
  this.fullnode = require('./fullnode')(this);
  this.chainblock = require('./chainblock')(this);
  this.chaindb = require('./chaindb')(this);
  this.chain = require('./chain')(this);
  this.mempool = require('./mempool')(this);
  this.keypair = require('./keypair')(this);
  this.hd = require('./hd')(this);
  this.address = require('./address')(this);
  this.wallet = require('./wallet')(this);
  this.walletdb = require('./walletdb')(this);
  this.provider = this.walletdb.provider;
  this.peer = require('./peer')(this);
  this.pool = require('./pool')(this);
  this.miner = require('./miner')(this);
  this.minerblock = this.miner.minerblock;
  this.http = require('./http')(this);
  this.workers = this.useWorkers && !this.isBrowser
    ? require('./work' + 'ers')(this)
    : null;
}

/**
 * Ensure the `prefix`.
 * @private
 */

Environment.prototype.ensurePrefix = function ensurePrefix() {
  if (this.isBrowser)
    return;

  if (this._ensured)
    return;

  this._ensured = true;

  try {
    fs.statSync(this.prefix);
  } catch (e) {
    fs.mkdirSync(this.prefix, 488 /* 0750 */);
  }
};

/**
 * Output a debug message.
 * @example
 * bcoin.debug('foo: %d', 10);
 */

Environment.prototype.debug = function debug() {
  var args = Array.prototype.slice.call(arguments);
  var msg;

  if (this.isBrowser) {
    if (this.debugLogs) {
      msg = typeof args[0] === 'object'
        ? args[0]
        : utils.format(args, false).slice(0, -1);
      console.error(msg);
    }
    return;
  }

  if (this.debugLogs) {
    msg = utils.format(args, true);
    process.stderr.write(msg);
  }

  if (this.debugFile) {
    if (!this._debug) {
      this.ensurePrefix();
      this._debug = fs.createWriteStream(this.debugFile, { flags: 'a' });
    }
    msg = utils.format(args, false);
    this._debug.write(process.pid + ': ' + msg);
  }
};

/**
 * Expose
 */

module.exports = Environment;
