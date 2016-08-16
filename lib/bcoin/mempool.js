/*!
 * mempool.js - mempool for bcoin
 * Copyright (c) 2014-2015, Fedor Indutny (MIT License)
 * Copyright (c) 2014-2016, Christopher Jeffrey (MIT License).
 * https://github.com/bcoin-org/bcoin
 */

'use strict';

/*
 * Database Layout:
 *  (inherits all from txdb)
 */

var bcoin = require('./env');
var AsyncObject = require('./async');
var constants = bcoin.protocol.constants;
var utils = require('./utils');
var assert = utils.assert;
var BufferWriter = require('./writer');
var BufferReader = require('./reader');
var VerifyError = bcoin.errors.VerifyError;

/**
 * Represents a mempool.
 * @exports Mempool
 * @constructor
 * @param {Object} options
 * @param {String?} options.name - Database name.
 * @param {String?} options.location - Database file location.
 * @param {String?} options.db - Database backend (`"memory"` by default).
 * @param {Boolean?} options.limitFree
 * @param {Number?} options.limitFreeRelay
 * @param {Number?} options.maxSize - Max pool size (default ~300mb).
 * @param {Boolean?} options.relayPriority
 * @param {Boolean?} options.requireStandard
 * @param {Boolean?} options.rejectAbsurdFees
 * @param {Boolean?} options.relay
 * @property {Boolean} loaded
 * @property {Object} db
 * @property {Number} size
 * @property {Number} totalOrphans
 * @property {Locker} locker
 * @property {Number} freeCount
 * @property {Number} lastTime
 * @property {Number} maxSize
 * @property {Boolean} blockSinceBump
 * @property {Number} lastFeeUpdate
 * @property {Rate} minFeeRate
 * @property {Rate} minReasonableFee
 * @property {Rate} minRelayFee
 * @emits Mempool#open
 * @emits Mempool#error
 * @emits Mempool#tx
 * @emits Mempool#add tx
 * @emits Mempool#remove tx
 */

function Mempool(options) {
  if (!(this instanceof Mempool))
    return new Mempool(options);

  AsyncObject.call(this);

  if (!options)
    options = {};

  this.options = options;
  this.chain = options.chain;
  this.fees = options.fees;

  assert(this.chain, 'Mempool requires a blockchain.');

  this.network = this.chain.network;
  this.logger = options.logger || this.chain.logger;
  this.loaded = false;

  this.locker = new bcoin.locker(this, this.addTX);

  this.size = 0;
  this.totalOrphans = 0;
  this.totalSpent = 0;
  this.totalTX = 0;

  this.waiting = {};
  this.orphans = {};
  this.tx = {};
  this.spents = {};
  this.coinIndex = new AddressIndex(this);
  this.txIndex = new AddressIndex(this);

  this.freeCount = 0;
  this.lastTime = 0;

  this.limitFree = this.options.limitFree !== false;
  this.limitFreeRelay = this.options.limitFreeRelay || 15;
  this.relayPriority = this.options.relayPriority !== false;
  this.requireStandard = this.options.requireStandard != null
    ? this.options.requireStandard
    : this.network.requireStandard;
  this.rejectAbsurdFees = this.options.rejectAbsurdFees !== false;
  this.prematureWitness = !!this.options.prematureWitness;

  this.maxSize = options.maxSize || constants.mempool.MAX_MEMPOOL_SIZE;
  this.blockSinceBump = false;
  this.lastFeeUpdate = utils.now();
  this.minFeeRate = 0;
  this.minReasonableFee = constants.tx.MIN_RELAY;
  this.minRelayFee = constants.tx.MIN_RELAY;
}

utils.inherits(Mempool, AsyncObject);

/**
 * Open the chain, wait for the database to load.
 * @alias Mempool#open
 * @param {Function} callback
 */

Mempool.prototype._open = function open(callback) {
  this.chain.open(callback);
};

/**
 * Close the chain, wait for the database to close.
 * @alias Mempool#close
 * @param {Function} callback
 */

Mempool.prototype._close = function destroy(callback) {
  return callback();
};

/**
 * Invoke mutex lock.
 * @private
 * @returns {Function} unlock
 */

Mempool.prototype._lock = function _lock(func, args, force) {
  return this.locker.lock(func, args, force);
};

/**
 * Notify the mempool that a new block has come
 * in (removes all transactions contained in the
 * block from the mempool).
 * @param {Block} block
 * @param {Function} callback
 */

Mempool.prototype.addBlock = function addBlock(block, callback) {
  var entries = [];
  var i, entry, tx, hash;

  for (i = block.txs.length - 1; i >= 0; i--) {
    tx = block.txs[i];
    hash = tx.hash('hex');

    if (tx.isCoinbase())
      continue;

    entry = this.getEntry(hash);

    if (!entry) {
      this.removeOrphan(hash);
      continue;
    }

    this.removeUnchecked(entry);
    this.emit('confirmed', tx, block);

    entries.push(entry);
  }

  this.blockSinceBump = true;
  this.lastFeeUpdate = utils.now();

  if (this.fees)
    this.fees.processBlock(block.height, entries, this.chain.isFull());

  return callback();
};

/**
 * Notify the mempool that a block has been disconnected
 * from the main chain (reinserts transactions into the mempool).
 * @param {Block} block
 * @param {Function} callback
 */

Mempool.prototype.removeBlock = function removeBlock(block, callback, force) {
  var self = this;
  var unlock, entry;

  unlock = this._lock(removeBlock, [block, callback], force);

  if (!unlock)
    return;

  callback = utils.wrap(callback, unlock);

  utils.forEachSerial(block.txs, function(tx, next) {
    var hash = tx.hash('hex');

    if (tx.isCoinbase())
      return next();

    if (self.hasTX(hash))
      return next();

    entry = MempoolEntry.fromTX(tx, block.height);

    self.addUnchecked(entry, function(err) {
      if (err)
        return next(err);

      self.emit('unconfirmed', tx, block);

      return next();
    }, true);
  }, callback);
};

/**
 * Ensure the size of the mempool stays below 300mb.
 * @param {Hash} entryHash - TX that initiated the trim.
 * @param {Function} callback
 */

Mempool.prototype.limitMempoolSize = function limitMempoolSize(entryHash) {
  var trimmed = false;
  var i, hashes, hash, end, entry;

  if (this.getSize() <= this.maxSize)
    return trimmed;

  hashes = this.getSnapshot();
  end = utils.now() - constants.mempool.MEMPOOL_EXPIRY;

  for (i = 0; i < hashes.length; i++) {
    hash = hashes[i];
    entry = this.getEntry(hash);

    if (!entry)
      continue;

    if (entry.ts >= end)
      continue;

    if (!trimmed && hash === entryHash)
      trimmed = true;

    this.removeUnchecked(entry, true);

    if (this.getSize() <= this.maxSize)
      return trimmed;
  }

  hashes = this.getSnapshot();

  for (i = 0; i < hashes.length; i++) {
    hash = hashes[i];
    entry = this.getEntry(hash);

    if (!entry)
      continue;

    if (!trimmed && hash === entryHash)
      trimmed = true;

    this.removeUnchecked(entry, true);

    if (this.getSize() <= this.maxSize)
      return trimmed;
  }

  return trimmed;
};

/**
 * Purge orphan transactions from the mempool.
 */

Mempool.prototype.limitOrphans = function limitOrphans() {
  var orphans = Object.keys(this.orphans);
  var i, hash;

  while (this.totalOrphans > constants.mempool.MAX_ORPHAN_TX) {
    i = bcoin.ec.rand(0, orphans.length);
    hash = orphans[i];
    orphans.splice(i, 1);

    this.logger.spam('Removing orphan %s from mempool.', utils.revHex(hash));

    this.removeOrphan(hash);
  }
};

/**
 * Retrieve a transaction from the mempool.
 * Note that this will not be filled with coins.
 * @param {TX|Hash} hash
 * @returns {TX}
 */

Mempool.prototype.getTX = function getTX(hash) {
  var entry = this.tx[hash];
  if (!entry)
    return;
  return entry.tx;
};

/**
 * Retrieve a transaction from the mempool.
 * Note that this will not be filled with coins.
 * @param {TX|Hash} hash
 * @returns {MempoolEntry}
 */

Mempool.prototype.getEntry = function getEntry(hash) {
  return this.tx[hash];
};

/**
 * Retrieve a coin from the mempool (unspents only).
 * @param {Hash} hash
 * @param {Number} index
 * @returns {Coin}
 */

Mempool.prototype.getCoin = function getCoin(hash, index) {
  var entry = this.tx[hash];

  if (!entry)
    return;

  if (this.isSpent(hash, index))
    return;

  if (index >= entry.tx.outputs.length)
    return;

  return bcoin.coin.fromTX(entry.tx, index);
};

/**
 * Check to see if a coin has been spent. This differs from
 * {@link ChainDB#isSpent} in that it actually maintains a
 * map of spent coins, whereas ChainDB may return `true`
 * for transaction outputs that never existed.
 * @param {Hash} hash
 * @param {Number} index
 * @returns {Boolean}
 */

Mempool.prototype.isSpent = function isSpent(hash, index) {
  return this.spents[hash + index];
};

/**
 * Find all coins pertaining to a certain address.
 * @param {Address[]} addresses
 * @returns {Coin[]}
 */

Mempool.prototype.getCoinsByAddress = function getCoinsByAddress(addresses) {
  var coins = [];
  var i, j, coin, hash;

  if (!Array.isArray(addresses))
    addresses = [addresses];

  for (i = 0; i < addresses.length; i++) {
    hash = bcoin.address.getHash(addresses[i], 'hex');
    if (!hash)
      continue;

    coin = this.coinIndex.getCoins(hash);

    for (j = 0; j < coin.length; j++)
      coins.push(coin[j]);
  }

  return coins;
};

/**
 * Find all transactions pertaining to a certain address.
 * @param {Address[]} addresses
 * @returns {TX[]}
 */

Mempool.prototype.getTXByAddress = function getTXByAddress(addresses) {
  var txs = [];
  var i, j, tx, hash;

  if (!Array.isArray(addresses))
    addresses = [addresses];

  for (i = 0; i < addresses.length; i++) {
    hash = bcoin.address.getHash(addresses[i], 'hex');
    if (!hash)
      continue;

    tx = this.txIndex.getTX(hash);

    for (j = 0; j < tx.length; j++)
      txs.push(tx[j]);
  }

  return txs;
};

/**
 * Fill a transaction with all available transaction outputs
 * in the mempool. This differs from {@link Mempool#fillCoins}
 * in that it will fill with all historical coins and not
 * just unspent coins.
 * @param {TX} tx
 */

Mempool.prototype.fillHistory = function fillHistory(tx) {
  var i, input, prevout, prev;

  if (tx.isCoinbase())
    return;

  for (i = 0; i < tx.inputs.length; i++) {
    input = tx.inputs[i];

    if (input.coin)
      continue;

    prevout = input.prevout;
    prev = this.getTX(prevout.hash);

    if (!prev)
      continue;

    input.coin = bcoin.coin.fromTX(prev, prevout.index);
  }
};

/**
 * Fill a transaction with all available (unspent) coins
 * in the mempool.
 * @param {TX} tx
 */

Mempool.prototype.fillCoins = function fillCoins(tx) {
  var i, input, prevout, coin;

  if (tx.isCoinbase())
    return;

  for (i = 0; i < tx.inputs.length; i++) {
    input = tx.inputs[i];

    if (input.coin)
      continue;

    prevout = input.prevout;
    coin = this.getCoin(prevout.hash, prevout.index);

    if (!coin)
      continue;

    input.coin = coin;
  }
};

/**
 * Test the mempool to see if it contains a transaction.
 * @param {Hash} hash
 * @returns {Boolean}
 */

Mempool.prototype.hasTX = function hasTX(hash) {
  return this.tx[hash] != null;
};

/**
 * Test the mempool to see if it contains a transaction or an orphan.
 * @param {Hash} hash
 * @returns {Boolean}
 */

Mempool.prototype.has = function has(hash) {
  if (this.locker.hasPending(hash))
    return true;

  if (this.hasOrphan(hash))
    return true;

  return this.hasTX(hash);
};

/**
 * Add a transaction to the mempool. Note that this
 * will lock the mempool until the transaction is
 * fully processed.
 * @param {TX} tx
 * @param {Function} callback - Returns [{@link VerifyError}].
 */

Mempool.prototype.addTX = function addTX(tx, callback, force) {
  var self = this;
  var lockFlags = constants.flags.STANDARD_LOCKTIME_FLAGS;
  var hash = tx.hash('hex');
  var ret = {};
  var unlock, entry;

  unlock = this._lock(addTX, [tx, callback], force);

  if (!unlock)
    return;

  if (tx.mutable)
    tx = tx.toTX();

  callback = utils.wrap(callback, unlock);
  callback = utils.asyncify(callback);

  if (tx.ts !== 0) {
    return callback(new VerifyError(tx,
      'alreadyknown',
      'txn-already-known',
      0));
  }

  if (!tx.isSane(ret)) {
    return callback(new VerifyError(tx,
      'invalid',
      ret.reason,
      ret.score));
  }

  if (tx.isCoinbase()) {
    return callback(new VerifyError(tx,
      'invalid',
      'coinbase',
      100));
  }

  if (this.requireStandard) {
    if (!this.chain.state.hasCSV() && tx.version >= 2) {
      return callback(new VerifyError(tx,
        'nonstandard',
        'premature-version2-tx',
        0));
    }
  }

  if (!this.chain.state.hasWitness() && !this.prematureWitness) {
    if (tx.hasWitness()) {
      return callback(new VerifyError(tx,
        'nonstandard',
        'no-witness-yet',
        0));
    }
  }

  if (this.requireStandard) {
    if (!tx.isStandard(ret)) {
      return callback(new VerifyError(tx,
        'nonstandard',
        ret.reason,
        ret.score));
    }
  }

  this.chain.checkFinal(this.chain.tip, tx, lockFlags, function(err, result) {
    if (err)
      return callback(err);

    if (!result) {
      return callback(new VerifyError(tx,
        'nonstandard',
        'non-final',
        0));
    }

    if (self.has(hash)) {
      return callback(new VerifyError(tx,
        'alreadyknown',
        'txn-already-in-mempool',
        0));
    }

    self.chain.db.hasCoins(hash, function(err, exists) {
      if (err)
        return callback(err);

      if (exists) {
        return callback(new VerifyError(tx,
          'alreadyknown',
          'txn-already-known',
          0));
      }

      if (self.isDoubleSpend(tx)) {
        return callback(new VerifyError(tx,
          'duplicate',
          'bad-txns-inputs-spent',
          0));
      }

      self.fillAllCoins(tx, function(err) {
        if (err)
          return callback(err);

        if (!tx.hasCoins()) {
          self.storeOrphan(tx);
          return callback();
        }

        entry = MempoolEntry.fromTX(tx, self.chain.height);

        self.verify(entry, function(err) {
          if (err)
            return callback(err);

          self.addUnchecked(entry, function(err) {
            if (err)
              return callback(err);

            if (self.limitMempoolSize(hash)) {
              return callback(new VerifyError(tx,
                'insufficientfee',
                'mempool full',
                0));
            }

            return callback();
          }, true);
        });
      });
    });
  });
};

/**
 * Add a transaction to the mempool without performing any
 * validation. Note that this method does not lock the mempool
 * and may lend itself to race conditions if used unwisely.
 * This function will also resolve orphans if possible (the
 * resolved orphans _will_ be validated).
 * @param {MempoolEntry} entry
 * @param {Function} callback - Returns [{@link VerifyError}].
 */

Mempool.prototype.addUnchecked = function addUnchecked(entry, callback, force) {
  var self = this;
  var unlock, resolved;

  unlock = this._lock(addUnchecked, [entry, callback], force);

  if (!unlock)
    return;

  callback = utils.wrap(callback, unlock);

  this._addUnchecked(entry);

  this.totalSpent += entry.tx.inputs.length;
  this.size += this.memUsage(entry.tx);
  this.totalTX++;
  this.emit('tx', entry.tx);
  this.emit('add tx', entry.tx);

  if (this.fees)
    this.fees.processTX(entry, this.chain.isFull());

  this.logger.debug('Added tx %s to mempool.', entry.tx.rhash);

  resolved = this.resolveOrphans(entry.tx);

  utils.forEachSerial(resolved, function(tx, next) {
    var entry = MempoolEntry.fromTX(tx, self.chain.height);
    self.verify(entry, function(err) {
      if (err) {
        if (err.type === 'VerifyError') {
          self.logger.debug('Could not resolve orphan %s: %s.',
            tx.rhash,
            err.message);
          self.emit('bad orphan', tx, entry);
          return next();
        }
        self.emit('error', err);
        return next();
      }
      self.addUnchecked(entry, function(err) {
        if (err) {
          self.emit('error', err);
          return next();
        }
        self.logger.spam('Resolved orphan %s in mempool.', entry.tx.rhash);
        next();
      }, true);
    });
  }, callback);
};

/**
 * Remove a transaction from the mempool. Generally
 * only called when a new block is added to the main chain.
 * @param {MempoolEntry} entry
 * @param {Function} callback
 */

Mempool.prototype.removeUnchecked = function removeUnchecked(entry, limit) {
  var rate, hash;

  this.removeOrphan(entry.tx);

  this._removeUnchecked(entry, limit);

  this.totalSpent -= entry.tx.inputs.length;
  this.size -= this.memUsage(entry.tx);
  this.totalTX--;

  if (this.fees) {
    hash = entry.tx.hash('hex');
    this.fees.removeTX(hash);
  }

  if (limit) {
    this.logger.spam('Removed tx %s from mempool.', entry.tx.rhash);
    rate = bcoin.tx.getRate(entry.sizes, entry.fees);
    rate += this.minReasonableFee;
    if (rate > this.minFeeRate) {
      this.minFeeRate = rate;
      this.blockSinceBump = false;
    }
  } else {
    this.logger.spam('Removed block tx %s from mempool.', entry.tx.rhash);
  }

  this.emit('remove tx', entry.tx);
};

/**
 * Calculate and update the minimum rolling fee rate.
 * @returns {Rate} Rate.
 */

Mempool.prototype.getMinRate = function getMinRate() {
  var now, halflife, size;

  if (!this.blockSinceBump || this.minFeeRate === 0)
    return this.minFeeRate;

  now = utils.now();

  if (now > this.lastFeeUpdate + 10) {
    halflife = constants.mempool.FEE_HALFLIFE;
    size = this.getSize();

    if (size < this.maxSize / 4)
      halflife >>>= 2;
    else if (size < this.maxSize / 2)
      halflife >>>= 1;

    this.minFeeRate /= Math.pow(2.0, (now - this.lastFeeUpdate) / halflife | 0);
    this.minFeeRate |= 0;
    this.lastFeeUpdate = now;

    if (this.minFeeRate < this.minReasonableFee / 2) {
      this.minFeeRate = 0;
      return 0;
    }
  }

  return Math.max(this.minFeeRate, this.minReasonableFee);
};

/**
 * Verify a transaction with mempool standards.
 * @param {TX} tx
 * @param {Function} callback - Returns [{@link VerifyError}].
 */

Mempool.prototype.verify = function verify(entry, callback) {
  var self = this;
  var height = this.chain.height + 1;
  var lockFlags = constants.flags.STANDARD_LOCKTIME_FLAGS;
  var flags = constants.flags.STANDARD_VERIFY_FLAGS;
  var mandatory = constants.flags.MANDATORY_VERIFY_FLAGS;
  var tx = entry.tx;
  var ret = {};
  var fee, modFee, now, size, rejectFee, minRelayFee, minRate, count;

  if (this.chain.state.hasWitness())
    mandatory |= constants.flags.VERIFY_WITNESS;
  else
    flags &= ~constants.flags.VERIFY_WITNESS;

  this.checkLocks(tx, lockFlags, function(err, result) {
    if (err)
      return callback(err);

    if (!result) {
      return callback(new VerifyError(tx,
        'nonstandard',
        'non-BIP68-final',
        0));
    }

    if (self.requireStandard && !tx.hasStandardInputs()) {
      return callback(new VerifyError(tx,
        'nonstandard',
        'bad-txns-nonstandard-inputs',
        0));
    }

    if (tx.getSigopsCost(flags) > constants.tx.MAX_SIGOPS_COST) {
      return callback(new VerifyError(tx,
        'nonstandard',
        'bad-txns-too-many-sigops',
        0));
    }

    fee = tx.getFee();
    modFee = entry.fees;
    size = entry.size;
    minRate = self.getMinRate();

    if (minRate > self.minRelayFee)
      self.network.updateMinRelay(minRate);

    rejectFee = tx.getMinFee(size, minRate);
    minRelayFee = tx.getMinFee(size, self.minRelayFee);

    if (rejectFee > 0 && modFee < rejectFee) {
      return callback(new VerifyError(tx,
        'insufficientfee',
        'mempool min fee not met',
        0));
    }

    if (self.relayPriority && modFee < minRelayFee) {
      if (!entry.isFree(height)) {
        return callback(new VerifyError(tx,
          'insufficientfee',
          'insufficient priority',
          0));
      }
    }

    // Continuously rate-limit free (really, very-low-fee)
    // transactions. This mitigates 'penny-flooding'. i.e.
    // sending thousands of free transactions just to be
    // annoying or make others' transactions take longer
    // to confirm.
    if (self.limitFree && modFee < minRelayFee) {
      now = utils.now();

      // Use an exponentially decaying ~10-minute window:
      self.freeCount *= Math.pow(1 - 1 / 600, now - self.lastTime);
      self.lastTime = now;

      // The limitFreeRelay unit is thousand-bytes-per-minute
      // At default rate it would take over a month to fill 1GB
      if (self.freeCount > self.limitFreeRelay * 10 * 1000) {
        return callback(new VerifyError(tx,
          'insufficientfee',
          'rate limited free transaction',
          0));
      }

      self.freeCount += size;
    }

    if (self.rejectAbsurdFees && fee > minRelayFee * 10000)
      return callback(new VerifyError(tx, 'highfee', 'absurdly-high-fee', 0));

    count = self.countAncestors(tx);

    if (count > constants.mempool.ANCESTOR_LIMIT) {
      return callback(new VerifyError(tx,
        'nonstandard',
        'too-long-mempool-chain',
        0));
    }

    if (!tx.checkInputs(height, ret))
      return callback(new VerifyError(tx, 'invalid', ret.reason, ret.score));

    // Do this in the worker pool.
    tx.verifyAsync(flags, function(err, result) {
      if (err)
        return callback(err);

      if (!result) {
        return tx.verifyAsync(mandatory, function(err, result) {
          if (err)
            return callback(err);

          if (result) {
            return callback(new VerifyError(tx,
              'nonstandard',
              'non-mandatory-script-verify-flag',
              0));
          }

          return callback(new VerifyError(tx,
            'nonstandard',
            'mandatory-script-verify-flag',
            0));
        });
      }

      return callback();
    });
  });
};

/**
 * Count the highest number of
 * ancestors a transaction may have.
 * @param {TX} tx
 * @returns {Number}
 */

Mempool.prototype.countAncestors = function countAncestors(tx) {
  var max = 0;
  var i, input, count, prev;

  for (i = 0; i < tx.inputs.length; i++) {
    input = tx.inputs[i];
    prev = this.getTX(input.prevout.hash);
    if (!prev)
      continue;
    count = 1;
    count += this.countAncestors(prev);
    if (count > max)
      max = count;
  }

  return max;
};

/**
 * Count the highest number of
 * descendants a transaction may have.
 * @param {TX} tx
 * @returns {Number}
 */

Mempool.prototype.countDescendants = function countDescendants(tx) {
  var max = 0;
  var hash = tx.hash('hex');
  var i, count, next;

  for (i = 0; i < tx.outputs.length; i++) {
    next = this.isSpent(hash, i);
    if (!next)
      continue;
    count = 1;
    count += this.countDescendants(next.tx);
    if (count > max)
      max = count;
  }

  return max;
};

/**
 * Find a unconfirmed transactions that
 * this transaction depends on.
 * @param {TX} tx
 * @returns {Hash[]}
 */

Mempool.prototype.getDepends = function getDepends(tx) {
  var prevout = tx.getPrevout();
  var depends = [];
  var i, hash;

  for (i = 0; i < prevout.length; i++) {
    hash = prevout[i].hash;
    if (this.hasTX(hash))
      depends.push(hash);
  }

  return depends;
};

/**
 * Store an orphaned transaction.
 * @param {TX} tx
 */

Mempool.prototype.storeOrphan = function storeOrphan(tx) {
  var prevout = {};
  var i, hash, input, prev;

  if (tx.getSize() > 99999) {
    this.logger.debug('Ignoring large orphan: %s', tx.rhash);
    this.emit('bad orphan', tx);
    return;
  }

  hash = tx.hash('hex');

  for (i = 0; i < tx.inputs.length; i++) {
    input = tx.inputs[i];
    if (!input.coin)
      prevout[input.prevout.hash] = true;
  }

  prevout = Object.keys(prevout);

  assert(prevout.length > 0);

  for (i = 0; i < prevout.length; i++) {
    prev = prevout[i];
    if (!this.waiting[prev])
      this.waiting[prev] = [];
    this.waiting[prev].push(hash);
  }

  this.orphans[hash] = tx.toExtended(true);
  this.totalOrphans++;

  this.logger.debug('Added orphan %s to mempool.', tx.rhash);

  this.emit('add orphan', tx);

  this.limitOrphans();
};

/**
 * Return the full balance of all unspents in the mempool
 * (not very useful in practice, only used for testing).
 * @returns {Amount}
 */

Mempool.prototype.getBalance = function getBalance() {
  var hashes = this.getSnapshot();
  var total = 0;
  var i, j, tx, hash, coin;

  for (i = 0; i < hashes.length; i++) {
    hash = hashes[i];
    tx = this.getTX(hash);
    if (!tx)
      continue;
    hash = tx.hash('hex');
    for (j = 0; j < tx.outputs.length; j++) {
      coin = this.getCoin(hash, j);
      if (coin)
        total += coin.value;
    }
  }

  return total;
};

/**
 * Retrieve _all_ transactions from the mempool.
 * @returns {TX[]}
 */

Mempool.prototype.getHistory = function getHistory() {
  var hashes = this.getSnapshot();
  var txs = [];
  var i, hash, tx;

  for (i = 0; i < hashes.length; i++) {
    hash = hashes[i];
    tx = this.getTX(hash);
    if (!tx)
      continue;
    txs.push(tx);
  }

  return txs;
};

/**
 * Retrieve an orphan transaction.
 * @param {Hash} hash
 * @returns {TX}
 */

Mempool.prototype.getOrphan = function getOrphan(hash) {
  var data = this.orphans[hash];
  var orphan;

  if (!data)
    return;

  try {
    orphan = bcoin.tx.fromExtended(data, true);
  } catch (e) {
    delete this.orphans[hash];
    this.logger.warning('%s %s',
      'Warning: possible memory corruption.',
      'Orphan failed deserialization.');
    return;
  }

  return orphan;
};

/**
 * @param {Hash} hash
 * @returns {Boolean}
 */

Mempool.prototype.hasOrphan = function hasOrphan(hash) {
  return this.orphans[hash] != null;
};

/**
 * Potentially resolve any transactions
 * that redeem the passed-in transaction.
 * Deletes all orphan entries and
 * returns orphan hashes.
 * @param {TX} tx
 * @returns {Array} Resolved
 */

Mempool.prototype.resolveOrphans = function resolveOrphans(tx) {
  var hash = tx.hash('hex');
  var resolved = [];
  var hashes = this.waiting[hash];
  var i, orphanHash, orphan;

  if (!hashes)
    return resolved;

  for (i = 0; i < hashes.length; i++) {
    orphanHash = hashes[i];
    orphan = this.getOrphan(orphanHash);

    if (!orphan)
      continue;

    orphan.fillCoins(tx);

    if (orphan.hasCoins()) {
      this.totalOrphans--;
      delete this.orphans[orphanHash];
      resolved.push(orphan);
      continue;
    }

    this.orphans[orphanHash] = orphan.toExtended(true);
  }

  delete this.waiting[hash];

  return resolved;
};

/**
 * Remove a transaction from the mempool.
 * @param {TX|Hash} tx
 */

Mempool.prototype.removeOrphan = function removeOrphan(tx) {
  var i, j, hashes, prevout, prev, hash;

  if (typeof tx === 'string')
    tx = this.getOrphan(tx);

  if (!tx)
    return;

  hash = tx.hash('hex');
  prevout = tx.getPrevout();

  for (i = 0; i < prevout.length; i++) {
    prev = prevout[i];
    hashes = this.waiting[prev];

    if (!hashes)
      continue;

    j = hashes.indexOf(hash);
    if (j !== -1)
      hashes.splice(j, 1);

    if (hashes.length === 0) {
      delete this.waiting[prev];
      continue;
    }

    this.waiting[prev] = hashes;
  }

  delete this.orphans[hash];

  this.emit('remove orphan', tx);

  this.totalOrphans--;
};

/**
 * Fill transaction with all unspent _and spent_
 * coins. Similar to {@link Mempool#fillHistory}
 * except that it will also fill with coins
 * from the blockchain as well.
 * @param {TX} tx
 * @param {Function} callback - Returns [Error, {@link TX}].
 */

Mempool.prototype.fillAllHistory = function fillAllHistory(tx, callback) {
  this.fillHistory(tx);

  if (tx.hasCoins())
    return callback(null, tx);

  this.chain.db.fillCoins(tx, callback);
};

/**
 * Fill transaction with all unspent
 * coins. Similar to {@link Mempool#fillCoins}
 * except that it will also fill with coins
 * from the blockchain as well.
 * @param {TX} tx
 * @param {Function} callback - Returns [Error, {@link TX}].
 */

Mempool.prototype.fillAllCoins = function fillAllCoins(tx, callback) {
  var self = this;

  this.fillCoins(tx);

  if (tx.hasCoins())
    return callback(null, tx);

  utils.forEachSerial(tx.inputs, function(input, next) {
    var hash = input.prevout.hash;
    var index = input.prevout.index;

    if (self.isSpent(hash, index))
      return next();

    self.chain.db.getCoin(hash, index, function(err, coin) {
      if (err)
        return next(err);

      if (!coin)
        return next();

      input.coin = coin;

      next();
    });
  }, function(err) {
    if (err)
      return callback(err);

    return callback(null, tx);
  });
};

/**
 * Get a snapshot of all transaction hashes in the mempool. Used
 * for generating INV packets in response to MEMPOOL packets.
 * @returns {Hash[]}
 */

Mempool.prototype.getSnapshot = function getSnapshot() {
  return Object.keys(this.tx);
};

/**
 * Check sequence locks on a transaction against the current tip.
 * @param {TX} tx
 * @param {LockFlags} flags
 * @param {Function} callback - Returns [Error, Boolean].
 */

Mempool.prototype.checkLocks = function checkLocks(tx, flags, callback) {
  return this.chain.checkLocks(this.chain.tip, tx, flags, callback);
};

/**
 * Test all of a transactions outpoints to see if they are doublespends.
 * Note that this will only test against the mempool spents, not the
 * blockchain's. The blockchain spents are not checked against because
 * the blockchain does not maintain a spent list. The transaction will
 * be seen as an orphan rather than a double spend.
 * @param {TX} tx
 * @param {Function} callback - Returns [Error, Boolean].
 */

Mempool.prototype.isDoubleSpend = function isDoubleSpend(tx) {
  var i, input, prevout;

  for (i = 0; i < tx.inputs.length; i++) {
    input = tx.inputs[i];
    prevout = input.prevout;
    if (this.isSpent(prevout.hash, prevout.index))
      return true;
  }

  return false;
};

/**
 * Calculate bitcoinj-style confidence.
 * @see http://bit.ly/1OVQwlO
 * @param {TX|Hash} hash
 * @param {Function} callback - Returns [Error, Number].
 */

Mempool.prototype.getConfidence = function getConfidence(hash, callback) {
  var tx;

  callback = utils.asyncify(callback);

  if (hash instanceof bcoin.tx) {
    tx = hash;
    hash = hash.hash('hex');
  } else {
    tx = this.getTX(hash);
  }

  if (this.hasTX(hash))
    return callback(null, constants.confidence.PENDING);

  if (tx && this.isDoubleSpend(tx))
    return callback(null, constants.confidence.INCONFLICT);

  if (tx && tx.block) {
    return this.chain.db.isMainChain(tx.block, function(err, result) {
      if (err)
        return callback(err);

      if (result)
        return callback(null, constants.confidence.BUILDING);

      return callback(null, constants.confidence.DEAD);
    });
  }

  this.chain.db.hasCoins(hash, function(err, existing) {
    if (err)
      return callback(err);

    if (existing)
      return callback(null, constants.confidence.BUILDING);

    return callback(null, constants.confidence.UNKNOWN);
  });
};

/**
 * Add a transaction to the mempool database.
 * @private
 * @param {MempoolEntry} entry
 */

Mempool.prototype._addUnchecked = function _addUnchecked(entry) {
  var tx = entry.tx;
  var hash = tx.hash('hex');
  var i, input, output, key, coin;

  this.tx[hash] = entry;

  if (this.options.indexAddress)
    this.indexTX.addTX(tx);

  for (i = 0; i < tx.inputs.length; i++) {
    input = tx.inputs[i];
    key = input.prevout.hash + input.prevout.index;

    if (tx.isCoinbase())
      break;

    assert(input.coin);

    if (this.options.indexAddress)
      this.coinIndex.removeCoin(input.coin);

    this.spents[key] = entry;
  }

  if (this.options.indexAddress) {
    for (i = 0; i < tx.outputs.length; i++) {
      output = tx.outputs[i];

      if (output.script.isUnspendable())
        continue;

      coin = bcoin.coin.fromTX(tx, i);
      this.coinIndex.addCoin(coin);
    }
  }
};

/**
 * Remove a transaction from the database. Note
 * that this _may_ not disconnect the inputs.
 * Transactions get removed for 2 reasons:
 * Either they are included in a block,
 * or they are limited.
 *
 * - If they are limited, we want to disconnect
 *   the inputs and also remove all spender
 *   transactions along with their outputs/coins.
 *
 * - If they are included in a block, we do not
 *   disconnect the inputs (the coins have already
 *   been used on the blockchain-layer). We also
 *   do not remove spenders, since they are still
 *   spending valid coins that exist on the blockchain.
 *
 * @private
 * @param {MempoolEntry} entry
 * @param {Boolean} limit
 * @param {Function} callback
 */

Mempool.prototype._removeUnchecked = function _removeUnchecked(entry, limit) {
  var tx = entry.tx;
  var hash = tx.hash('hex');
  var i, input, output, key, coin;

  // We do not remove spenders if this is
  // being removed for a block. The spenders
  // are still spending valid coins (which
  // now exist on the blockchain).
  if (limit)
    this._removeSpenders(entry);

  delete this.tx[hash];

  if (this.options.indexAddress)
    this.txIndex.removeTX(tx);

  for (i = 0; i < tx.inputs.length; i++) {
    input = tx.inputs[i];
    key = input.prevout.hash + input.prevout.index;

    if (tx.isCoinbase())
      break;

    delete this.spents[key];

    assert(input.coin);

    if (this.options.indexAddress)
      this.coinIndex.removeCoin(input.coin);
  }

  if (this.options.indexAddress) {
    for (i = 0; i < tx.outputs.length; i++) {
      output = tx.outputs[i];

      if (output.script.isUnspendable())
        continue;

      coin = bcoin.coin.fromTX(tx, i);
      this.coinIndex.removeCoin(coin);
    }
  }
};

/**
 * Recursively remove spenders of a transaction.
 * @private
 * @param {MempoolEntry} entry
 * @param {Boolean} limit
 * @param {Function} callback
 */

Mempool.prototype._removeSpenders = function _removeSpenders(entry) {
  var tx = entry.tx;
  var hash = tx.hash('hex');
  var i, spender;

  for (i = 0; i < tx.outputs.length; i++) {
    spender = this.isSpent(hash, i);

    if (!spender)
      continue;

    this.removeUnchecked(spender, true);
  }
};

/**
 * Calculate the memory usage of a transaction.
 * @param {TX} tx
 * @returns {Number} Usage in bytes.
 */

Mempool.prototype.memUsage = function memUsage(tx) {
  var mem = 0;
  var i, j, input, output;

  mem += 8;

  for (i = 0; i < tx.inputs.length; i++) {
    input = tx.inputs[i];
    if (input.coin) {
      mem += 93;
      mem += input.coin.script.getSize() * 2;
    }
    mem += 76;
    mem += input.script.getSize() * 2;
    for (j = 0; j < input.witness.items.length; j++)
      mem += input.witness.items[j].length;
  }

  for (i = 0; i < tx.outputs.length; i++) {
    output = tx.outputs[i];
    mem += 8;
    mem += output.script.getSize() * 2;
  }

  mem += 8;

  // Mempool Entry
  mem += 40;

  // Map entry
  mem += 64;

  // Spent entry
  mem += 64;

  return mem;
};

/**
 * Calculate the memory usage of the entire mempool.
 * @see DynamicMemoryUsage()
 * @returns {Number} Usage in bytes.
 */

Mempool.prototype.getSize = function getSize() {
  return this.size;
};

/**
 * Represents a mempool entry.
 * @exports MempoolEntry
 * @constructor
 * @param {Object} options
 * @param {TX} options.tx - Transaction in mempool.
 * @param {Number} options.height - Entry height.
 * @param {Number} options.priority - Entry priority.
 * @param {Number} options.ts - Entry time.
 * @param {Amount} options.chainValue - Value of on-chain coins.
 * @param {Number} options.count - Number of descendants (includes tx).
 * @param {Number} options.size - TX and descendant modified size.
 * @param {Amount} options.fees - TX and descendant delta-applied fees.
 * @property {TX} tx
 * @property {Number} height
 * @property {Number} priority
 * @property {Number} ts
 * @property {Amount} chainValue
 * @property {Number} count
 * @property {Number} size
 * @property {Amount} fees
 */

function MempoolEntry(options) {
  if (!(this instanceof MempoolEntry))
    return new MempoolEntry(options);

  this.tx = null;
  this.height = -1;
  this.size = 0;
  this.priority = 0;
  this.fee = 0;
  this.ts = 0;

  this.chainValue = 0;
  this.count = 0;
  this.sizes = 0;
  this.fees = 0;
  this.dependencies = false;

  if (options)
    this.fromOptions(options);
}

/**
 * Inject properties from options object.
 * @private
 * @param {Object} options
 */

MempoolEntry.prototype.fromOptions = function fromOptions(options) {
  this.tx = options.tx;
  this.height = options.height;
  this.size = options.size;
  this.priority = options.priority;
  this.fee = options.fee;
  this.ts = options.ts;

  this.chainValue = options.chainValue;
  this.count = options.count;
  this.sizes = options.sizes;
  this.fees = options.fees;
  this.dependencies = options.dependencies;

  return this;
};

/**
 * Instantiate mempool entry from options.
 * @param {Object} options
 * @returns {MempoolEntry}
 */

MempoolEntry.fromOptions = function fromOptions(options) {
  return new MempoolEntry().fromOptions(options);
};

/**
 * Inject properties from transaction.
 * @private
 * @param {TX} tx
 * @param {Number} height
 */

MempoolEntry.prototype.fromTX = function fromTX(tx, height) {
  var priority = tx.getPriority(height);
  var value = tx.getChainValue(height);
  var dependencies = false;
  var size = tx.getVirtualSize();
  var fee = tx.getFee();
  var i;

  for (i = 0; i < tx.inputs.length; i++) {
    if (tx.inputs[i].coin.height === -1) {
      dependencies = true;
      break;
    }
  }

  this.tx = tx;
  this.height = height;
  this.size = size;
  this.priority = priority;
  this.fee = fee;
  this.chainValue = value;
  this.ts = utils.now();
  this.count = 1;
  this.sizes = size;
  this.fees = fee;
  this.dependencies = dependencies;

  return this;
};

/**
 * Create a mempool entry from a TX.
 * @param {TX} tx
 * @param {Number} height - Entry height.
 * @returns {MempoolEntry}
 */

MempoolEntry.fromTX = function fromTX(tx, height) {
  return new MempoolEntry().fromTX(tx, height);
};

/**
 * Serialize a mempool entry. Note that this
 * can still be parsed as a regular tx since
 * the mempool entry data comes after the
 * serialized transaction.
 * @param {BufferWriter?} writer
 * @returns {Buffer}
 */

MempoolEntry.prototype.toRaw = function toRaw(writer) {
  var p = new BufferWriter(writer);

  this.tx.toRaw(p);

  p.writeU32(this.height);
  p.writeU32(this.size);
  p.writeDouble(this.priority);
  p.writeVarint(this.fee);
  p.writeVarint(this.chainValue);
  p.writeU32(this.ts);
  p.writeU32(this.count);
  p.writeU32(this.sizes);
  p.writeVarint(this.fees);
  p.writeU8(this.dependencies ? 1 : 0);

  if (!writer)
    p = p.render();

  return p;
};

/**
 * Inject properties from serialized data.
 * @private
 * @param {Buffer} data
 */

MempoolEntry.prototype.fromRaw = function fromRaw(data) {
  var p = new BufferReader(data);
  this.tx = bcoin.tx.fromRaw(p);
  this.height = p.readU32();
  this.size = p.readU32();
  this.priority = p.readDouble();
  this.fee = p.readVarint();
  this.chainValue = p.readVarint();
  this.ts = p.readU32();
  this.count = p.readU32();
  this.sizes = p.readU32();
  this.fees = p.readVarint();
  this.dependencies = p.readU8() === 1;
  return this;
};

/**
 * Create a mempool entry from serialized data.
 * @param {Buffer|BufferReader} data
 * @returns {MempoolEntry}
 */

MempoolEntry.fromRaw = function fromRaw(data) {
  return new MempoolEntry().fromRaw(data);
};

/**
 * Calculate priority, taking into account
 * the entry height delta, modified size,
 * and chain value.
 * @param {Number} height
 * @returns {Number} Priority.
 */

MempoolEntry.prototype.getPriority = function getPriority(height) {
  var heightDelta = height - this.height;
  var modSize = this.tx.getModifiedSize(this.size);
  var deltaPriority = (heightDelta * this.chainValue) / modSize;
  var result = this.priority + Math.floor(deltaPriority);
  if (result < 0)
    result = 0;
  return result;
};

/**
 * Get fee.
 * @returns {Amount}
 */

MempoolEntry.prototype.getFee = function getFee() {
  return this.fee;
};

/**
 * Calculate fee rate.
 * @returns {Rate}
 */

MempoolEntry.prototype.getRate = function getRate() {
  return bcoin.tx.getRate(this.size, this.fee);
};

/**
 * Test whether the entry is free with
 * the current priority (calculated by
 * current height).
 * @param {Number} height
 * @returns {Boolean}
 */

MempoolEntry.prototype.isFree = function isFree(height) {
  var priority = this.getPriority(height);
  return priority > constants.tx.FREE_THRESHOLD;
};

/**
 * Address Index
 */

function AddressIndex(mempool) {
  this.mempool = mempool;
  this.map = {};
}

AddressIndex.prototype.getCoins = function getCoins(address) {
  var items = this.map[address];
  var out = [];
  var i, item, outpoint, coin;

  if (!items)
    return out;

  for (i = 0; i < items.length; i++) {
    item = items[i];
    outpoint = bcoin.outpoint.fromRaw(item);
    coin = this.mempool.getCoin(outpoint.hash, outpoint.index);
    assert(coin);
    out.push(coin);
  }

  return out;
};

AddressIndex.prototype.getTX = function getTX(address) {
  var items = this.map[address];
  var out = [];
  var i, hash, tx;

  if (!items)
    return out;

  for (i = 0; i < items.length; i++) {
    hash = items[i].toString('hex');
    tx = this.mempool.getTX(hash);
    assert(tx);
    out.push(tx);
  }

  return out;
};

AddressIndex.prototype.addTX = function addTX(tx) {
  var hashes = tx.getHashes('hex');
  var i, hash, items;

  for (i = 0; i < hashes.length; i++) {
    hash = hashes[i];
    items = this.map[hash];

    if (!items) {
      items = [];
      this.map[hash] = items;
    }

    utils.binaryInsert(items, tx.hash(), utils.cmp);
  }
};

AddressIndex.prototype.removeTX = function removeTX(tx) {
  var hashes = tx.getHashes('hex');
  var i, hash, items;

  for (i = 0; i < hashes.length; i++) {
    hash = hashes[i];
    items = this.map[hash];

    if (!items)
      continue;

    utils.binaryRemove(items, tx.hash(), utils.cmp);

    if (items.length === 0)
      delete this.map[hash];
  }
};

AddressIndex.prototype.addCoin = function addCoin(coin) {
  var hash = coin.getHash('hex');
  var outpoint, items;

  if (!hash)
    return;

  items = this.map[hash];

  if (!items) {
    items = [];
    this.map[hash] = items;
  }

  outpoint = bcoin.outpoint(coin.hash, coin.index).toRaw();
  utils.binaryInsert(items, outpoint, utils.cmp);
};

AddressIndex.prototype.removeCoin = function removeCoin(coin) {
  var hash = coin.getHash('hex');
  var outpoint, items;

  if (!hash)
    return;

  items = this.map[hash];

  if (!items)
    return;

  outpoint = bcoin.outpoint(coin.hash, coin.index).toRaw();
  utils.binaryRemove(items, outpoint, utils.cmp);

  if (items.length === 0)
    delete this.map[hash];
};

/*
 * Expose
 */

exports = Mempool;
exports.MempoolEntry = MempoolEntry;

module.exports = exports;
