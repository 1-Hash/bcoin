/*!
 * txdb.js - persistent transaction pool
 * Copyright (c) 2014-2015, Fedor Indutny (MIT License)
 * Copyright (c) 2014-2016, Christopher Jeffrey (MIT License).
 * https://github.com/bcoin-org/bcoin
 */

'use strict';

var bcoin = require('./env');
var utils = require('./utils');
var assert = bcoin.utils.assert;
var constants = bcoin.protocol.constants;
var DUMMY = new Buffer([0]);
var BufferReader = require('./reader');
var BufferWriter = require('./writer');

/*
 * Database Layout:
 *   t[hash] -> extended tx
 *   c[hash][index] -> coin
 *   d[hash][index] -> undo coin
 *   s[hash][index] -> spent by hash
 *   o[hash][index] -> orphan inputs
 *   p[hash] -> dummy (pending flag)
 *   m[time][hash] -> dummy (tx by time)
 *   h[height][hash] -> dummy (tx by height)
 *   T[account][hash] -> dummy (tx by account)
 *   P[account][hash] -> dummy (pending tx by account)
 *   M[account][time][hash] -> dummy (tx by time + account)
 *   H[account][height][hash] -> dummy (tx by height + account)
 *   C[account][hash][index] -> dummy (coin by account)
 */

/* String Keys
var layout = {
  prefix: function prefix(wid, key) {
    return 't' + pad32(wid) + key;
  },

  hi: function hi(ch, hash, index) {
    return this.prefix(ch + hash + pad32(index));
  },

  hii: function hii(key) {
    key = key.slice(12);
    return [key.slice(0, 64), +key.slice(64)];
  },

  ih: function ih(ch, index, hash) {
    return this.prefix(ch + pad32(index) + hash);
  },

  ihh: function ihh(key) {
    key = key.slice(12);
    return [+key.slice(0, 10), key.slice(10)];
  },

  iih: function iih(ch, index, num, hash) {
    return this.prefix(ch + pad32(index) + pad32(num) + hash);
  },

  iihh: function iihh(key) {
    key = key.slice(12);
    return [+key.slice(0, 10), +key.slice(10, 20), key.slice(20)];
  },

  ihi: function ihi(ch, index, hash, num) {
    return this.prefix(ch + pad32(index) + hash + pad32(num));
  },

  ihii: function ihii(key) {
    key = key.slice(12);
    return [+key.slice(0, 10), key.slice(10, 74), +key.slice(74)];
  },

  ha: function ha(ch, hash) {
    return this.prefix(ch + hash);
  },

  haa: function haa(key) {
    key = key.slice(12);
    return key;
  },

  ...
};
*/

var layout = {
  prefix: function prefix(wid, key) {
    var out = new Buffer(5 + key.length);
    out[0] = 0x74;
    out.writeUInt32BE(wid, 1);
    key.copy(out, 5);
    return out;
  },
  hi: function hi(ch, hash, index) {
    var key = new Buffer(37);
    key[0] = ch;
    key.write(hash, 1, 'hex');
    key.writeUInt32BE(index, 33, true);
    return key;
  },
  hii: function hii(key) {
    key = key.slice(6);
    return [key.toString('hex', 0, 32), key.readUInt32BE(32, true)];
  },
  ih: function ih(ch, index, hash) {
    var key = new Buffer(37);
    key[0] = ch;
    key.writeUInt32BE(index, 1, true);
    key.write(hash, 5, 'hex');
    return key;
  },
  ihh: function ihh(key) {
    key = key.slice(6);
    return [key.readUInt32BE(0, true), key.toString('hex', 4, 36)];
  },
  iih: function iih(ch, index, num, hash) {
    var key = new Buffer(41);
    key[0] = ch;
    key.writeUInt32BE(index, 1, true);
    key.writeUInt32BE(num, 5, true);
    key.write(hash, 9, 'hex');
    return key;
  },
  iihh: function iihh(key) {
    key = key.slice(6);
    return [
      key.readUInt32BE(0, true),
      key.readUInt32BE(4, true),
      key.toString('hex', 8, 40)
    ];
  },
  ihi: function ihi(ch, index, hash, num) {
    var key = new Buffer(41);
    key[0] = ch;
    key.writeUInt32BE(index, 1, true);
    key.write(hash, 5, 'hex');
    key.writeUInt32BE(num, 37, true);
    return key;
  },
  ihii: function ihii(key) {
    key = key.slice(6);
    return [
      key.readUInt32BE(0, true),
      key.toString('hex', 4, 36),
      key.readUInt32BE(36, true)
    ];
  },
  ha: function ha(ch, hash) {
    var key = new Buffer(33);
    key[0] = ch;
    key.write(hash, 1, 'hex');
    return key;
  },
  haa: function haa(key) {
    return key.toString('hex', 1);
  },
  t: function t(hash) {
    return layout.ha(0x74, hash);
  },
  tt: function tt(key) {
    return layout.haa(key);
  },
  c: function c(hash, index) {
    return layout.hi(0x63, hash, index);
  },
  cc: function cc(key) {
    return layout.hii(key);
  },
  d: function d(hash, index) {
    return layout.hi(0x64, hash, index);
  },
  dd: function dd(key) {
    return layout.hii(key);
  },
  s: function s(hash, index) {
    return layout.hi(0x73, hash, index);
  },
  ss: function ss(key) {
    return layout.hii(key);
  },
  o: function o(hash, index) {
    return layout.hi(0x6f, hash, index);
  },
  oo: function oo(key) {
    return layout.hii(key);
  },
  p: function p(hash) {
    return layout.ha(0x70, hash);
  },
  pp: function pp(key) {
    return layout.haa(key);
  },
  m: function m(time, hash) {
    return layout.ih(0x6d, time, hash);
  },
  mm: function mm(key) {
    return layout.ihh(key);
  },
  h: function h(height, hash) {
    return layout.ih(0x68, height, hash);
  },
  hh: function hh(key) {
    return layout.ihh(key);
  },
  T: function T(account, hash) {
    return layout.ih(0x54, account, hash);
  },
  Tt: function Tt(key) {
    return layout.ihh(key);
  },
  P: function P(account, hash) {
    return layout.ih(0x50, account, hash);
  },
  Pp: function Pp(key) {
    return layout.ihh(key);
  },
  M: function M(account, time, hash) {
    return layout.iih(0x4d, account, time, hash);
  },
  Mm: function Mm(key) {
    return layout.iihh(key);
  },
  H: function H(account, height, hash) {
    return layout.iih(0x48, account, height, hash);
  },
  Hh: function Hh(key) {
    return layout.iihh(key);
  },
  C: function C(account, hash, index) {
    return layout.ihi(0x43, account, hash, index);
  },
  Cc: function Cc(key) {
    return layout.ihii(key);
  }
};

/**
 * TXDB
 * @exports TXDB
 * @constructor
 * @param {Wallet} wallet
 */

function TXDB(wallet) {
  if (!(this instanceof TXDB))
    return new TXDB(wallet);

  this.wallet = wallet;
  this.walletdb = wallet.db;
  this.db = wallet.db.db;
  this.logger = wallet.db.logger;
  this.network = wallet.db.network;
  this.options = wallet.db.options;
  this.locked = {};

  this.locker = new bcoin.locker(this);
  this.coinCache = new bcoin.lru(10000, 1);

  this.current = null;
  this.balance = null;
}

/**
 * Open TXDB.
 * @param {Function} callback
 */

TXDB.prototype.open = function open(callback) {
  var self = this;

  this.getBalance(function(err, balance) {
    if (err)
      return callback(err);

    self.logger.info('TXDB loaded for %s.', self.wallet.id);
    self.logger.info(
      'Balance: unconfirmed=%s confirmed=%s total=%s.',
      utils.btc(balance.unconfirmed),
      utils.btc(balance.confirmed),
      utils.btc(balance.total));

    self.balance = balance;

    callback();
  });
};

/**
 * Emit transaction event.
 * @private
 * @param {String} event
 * @param {TX} tx
 * @param {PathInfo} info
 */

TXDB.prototype.emit = function emit(event, tx, info) {
  this.walletdb.emit(event, info.id, tx, info);
  this.wallet.emit(event, tx, info);
};

/**
 * Invoke the mutex lock.
 * @private
 * @returns {Function} unlock
 */

TXDB.prototype._lock = function _lock(func, args, force) {
  return this.locker.lock(func, args, force);
};

/**
 * Prefix a key.
 * @param {Buffer} key
 * @returns {Buffer} Prefixed key.
 */

TXDB.prototype.prefix = function prefix(key) {
  assert(this.wallet.wid);
  return layout.prefix(this.wallet.wid, key);
};

/**
 * Start a batch.
 * @returns {Batch}
 */

TXDB.prototype.start = function start() {
  assert(!this.current);
  this.current = this.db.batch();
  return this.current;
};

/**
 * Put key and value to current batch.
 * @param {String} key
 * @param {Buffer} value
 */

TXDB.prototype.put = function put(key, value) {
  assert(this.current);
  this.current.put(this.prefix(key), value);
};

/**
 * Delete key from current batch.
 * @param {String} key
 */

TXDB.prototype.del = function del(key) {
  assert(this.current);
  this.current.del(this.prefix(key));
};

/**
 * Get current batch.
 * @returns {Batch}
 */

TXDB.prototype.batch = function batch() {
  assert(this.current);
  return this.current;
};

/**
 * Drop current batch.
 * @returns {Batch}
 */

TXDB.prototype.drop = function drop() {
  assert(this.current);
  this.current.clear();
  this.current = null;
};

/**
 * Fetch.
 * @param {String} key
 */

TXDB.prototype.fetch = function fetch(key, parse, callback) {
  this.db.fetch(this.prefix(key), parse, callback);
};

/**
 * Get.
 * @param {String} key
 */

TXDB.prototype.get = function get(key, callback) {
  this.db.get(this.prefix(key), callback);
};

/**
 * Has.
 * @param {String} key
 */

TXDB.prototype.has = function has(key, callback) {
  this.db.has(this.prefix(key), callback);
};

/**
 * Iterate.
 * @param {Object} options
 * @param {Function} callback
 */

TXDB.prototype.iterate = function iterate(options, callback) {
  if (options.gte)
    options.gte = this.prefix(options.gte);
  if (options.lte)
    options.lte = this.prefix(options.lte);
  this.db.iterate(options, callback);
};

/**
 * Commit current batch.
 * @param {Function} callback
 */

TXDB.prototype.commit = function commit(callback) {
  var self = this;
  assert(this.current);
  this.current.write(function(err) {
    if (err) {
      self.current = null;
      return callback(err);
    }
    self.current = null;
    callback();
  });
};

/**
 * Map a transactions' addresses to wallet IDs.
 * @param {TX} tx
 * @param {Function} callback - Returns [Error, {@link PathInfo}].
 */

TXDB.prototype.getInfo = function getInfo(tx, callback) {
  this.walletdb.getPathInfo(this.wallet, tx, callback);
};

/**
 * Add an orphan (tx hash + input index)
 * to orphan list. Stored by its required coin ID.
 * @private
 * @param {Outpoint} prevout - Required coin hash & index.
 * @param {Buffer} spender - Spender input hash and index.
 * @param {Function} callback - Returns [Error, Buffer].
 */

TXDB.prototype._addOrphan = function _addOrphan(prevout, spender, callback) {
  var self = this;
  var p = new BufferWriter();
  var key = layout.o(prevout.hash, prevout.index);

  this.get(key, function(err, data) {
    if (err)
      return callback(err);

    if (data)
      p.writeBytes(data);

    p.writeBytes(spender);

    self.put(key, p.render());

    callback();
  });
};

/**
 * Retrieve orphan list by coin ID.
 * @private
 * @param {Hash} hash
 * @param {Number} index
 * @param {Function} callback - Returns [Error, {@link Orphan}].
 */

TXDB.prototype._getOrphans = function _getOrphans(hash, index, callback) {
  var self = this;
  var items = [];

  this.fetch(layout.o(hash, index), function(data) {
    var p = new BufferReader(data);
    var orphans = [];

    while (p.left())
      orphans.push(bcoin.outpoint.fromRaw(p));

    return orphans;
  }, function(err, orphans) {
    if (err)
      return callback(err);

    if (!orphans)
      return callback();

    utils.forEachSerial(orphans, function(orphan, next) {
      self.getTX(orphan.hash, function(err, tx) {
        if (err)
          return next(err);

        items.push([orphan, tx]);

        next();
      });
    }, function(err) {
      if (err)
        return callback(err);

      callback(null, items);
    });
  });
};

/**
 * Retrieve coins for own inputs, remove
 * double spenders, and verify inputs.
 * @private
 * @param {TX} tx
 * @param {PathInfo} info
 * @param {Function} callback - Returns [Error].
 */

TXDB.prototype._verify = function _verify(tx, info, callback) {
  var self = this;

  utils.forEachSerial(tx.inputs, function(input, next, i) {
    var prevout = input.prevout;
    var address;

    if (tx.isCoinbase())
      return next();

    address = input.getHash('hex');

    // Only bother if this input is ours.
    if (!info.hasPath(address))
      return next();

    self.getCoin(prevout.hash, prevout.index, function(err, coin) {
      if (err)
        return next(err);

      if (coin) {
        // Add TX to inputs and spend money
        input.coin = coin;

        // Skip invalid transactions
        if (self.options.verify) {
          if (!tx.verifyInput(i))
            return callback(null, false);
        }

        return next();
      }

      input.coin = null;

      self.isSpent(prevout.hash, prevout.index, function(err, spent) {
        if (err)
          return next(err);

        // Are we double-spending?
        // Replace older txs with newer ones.
        if (!spent)
          return next();

        self.getSpentCoin(spent, prevout, function(err, coin) {
          if (err)
            return next(err);

          if (!coin)
            return callback(new Error('Could not find double-spent coin.'));

          input.coin = coin;

          // Skip invalid transactions
          if (self.options.verify) {
            if (!tx.verifyInput(i))
              return callback(null, false);
          }

          self._removeConflict(spent.hash, tx, function(err, tx, info) {
            if (err)
              return next(err);

            // Spender was not removed, the current
            // transaction is not elligible to be added.
            if (!tx)
              return callback(null, false);

            // Emit the _removed_ transaction.
            self.emit('conflict', tx, info);

            next();
          });
        });
      });
    });
  }, function(err) {
    if (err)
      return callback(err);
    callback(null, true);
  });
};

/**
 * Attempt to resolve orphans for an output.
 * @private
 * @param {TX} tx
 * @param {Number} index
 * @param {Function} callback
 */

TXDB.prototype._resolveOrphans = function _resolveOrphans(tx, index, callback) {
  var self = this;
  var hash = tx.hash('hex');
  var coin;

  this._getOrphans(hash, index, function(err, orphans) {
    if (err)
      return callback(err);

    if (!orphans)
      return callback(null, false);

    self.del(layout.o(hash, index));

    coin = bcoin.coin.fromTX(tx, index);

    // Add input to orphan
    utils.forEachSerial(orphans, function(item, next) {
      var input = item[0];
      var orphan = item[1];

      // Probably removed by some other means.
      if (!orphan)
        return next();

      orphan.inputs[input.index].coin = coin;

      assert(orphan.inputs[input.index].prevout.hash === hash);
      assert(orphan.inputs[input.index].prevout.index === index);

      // Verify that input script is correct, if not - add
      // output to unspent and remove orphan from storage
      if (!self.options.verify || orphan.verifyInput(input.index)) {
        self.put(layout.d(input.hash, input.index), coin.toRaw());
        return callback(null, true);
      }

      self._lazyRemove(orphan, next);
    }, function(err) {
      if (err)
        return callback(err);

      // Just going to be added again outside.
      self.balance.sub(coin);

      callback(null, false);
    });
  });
};

/**
 * Add transaction, runs _confirm (separate batch) and
 * verify (separate batch for double spenders).
 * @private
 * @param {TX} tx
 * @param {PathInfo} info
 * @param {Function} callback
 */

TXDB.prototype.add = function add(tx, info, callback) {
  var self = this;
  var unlock = this._lock(add, [tx, info, callback]);
  var hash, i, path, account;

  if (!unlock)
    return;

  callback = utils.wrap(callback, unlock);

  assert(!tx.mutable, 'Cannot add mutable TX to wallet.');

  // Attempt to confirm tx before adding it.
  this._confirm(tx, info, function(err, existing) {
    if (err)
      return callback(err);

    // Ignore if we already have this tx.
    if (existing)
      return callback(null, true, info);

    self._verify(tx, info, function(err, result) {
      if (err)
        return callback(err);

      if (!result)
        return callback(null, result, info);

      hash = tx.hash('hex');

      self.start();
      self.put(layout.t(hash), tx.toExtended());

      if (tx.ts === 0)
        self.put(layout.p(hash), DUMMY);
      else
        self.put(layout.h(tx.height, hash), DUMMY);

      self.put(layout.m(tx.ps, hash), DUMMY);

      for (i = 0; i < info.accounts.length; i++) {
        account = info.accounts[i];
        self.put(layout.T(account, hash), DUMMY);
        if (tx.ts === 0)
          self.put(layout.P(account, hash), DUMMY);
        else
          self.put(layout.H(account, tx.height, hash), DUMMY);
        self.put(layout.M(account, tx.ps, hash), DUMMY);
      }

      // Consume unspent money or add orphans
      utils.forEachSerial(tx.inputs, function(input, next, i) {
        var prevout = input.prevout;
        var key, address, spender;

        if (tx.isCoinbase())
          return next();

        address = input.getHash('hex');
        path = info.getPath(address);

        // Only bother if this input is ours.
        if (!path)
          return next();

        key = prevout.hash + prevout.index;

        // s/[outpoint-key] -> [spender-hash]|[spender-input-index]
        spender = bcoin.outpoint.fromTX(tx, i).toRaw();
        self.put(layout.s(prevout.hash, prevout.index), spender);

        // Add orphan, if no parent transaction is yet known
        if (!input.coin)
          return self._addOrphan(prevout, spender, next);

        self.del(layout.c(prevout.hash, prevout.index));
        self.del(layout.C(path.account, prevout.hash, prevout.index));
        self.put(layout.d(hash, i), input.coin.toRaw());
        self.balance.sub(input.coin);

        self.coinCache.remove(key);

        next();
      }, function(err) {
        if (err) {
          self.drop();
          return callback(err);
        }

        // Add unspent outputs or resolve orphans
        utils.forEachSerial(tx.outputs, function(output, next, i) {
          var address = output.getHash('hex');
          var key = hash + i;
          var coin;

          path = info.getPath(address);

          // Do not add unspents for outputs that aren't ours.
          if (!path)
            return next();

          self._resolveOrphans(tx, i, function(err, orphans) {
            if (err)
              return next(err);

            if (orphans)
              return next();

            coin = bcoin.coin.fromTX(tx, i);
            self.balance.add(coin);
            coin = coin.toRaw();

            self.put(layout.c(hash, i), coin);
            self.put(layout.C(path.account, hash, i), DUMMY);

            self.coinCache.set(key, coin);

            next();
          });
        }, function(err) {
          if (err) {
            self.drop();
            return callback(err);
          }

          self.commit(function(err) {
            if (err)
              return callback(err);

            // Clear any locked coins to free up memory.
            self.unlockTX(tx);

            self.emit('tx', tx, info);

            if (tx.ts !== 0)
              self.emit('confirmed', tx, info);

            callback(null, true, info);
          });
        });
      });
    });
  });
};

/**
 * Remove spenders that have not been confirmed. We do this in the
 * odd case of stuck transactions or when a coin is double-spent
 * by a newer transaction. All previously-spending transactions
 * of that coin that are _not_ confirmed will be removed from
 * the database.
 * @private
 * @param {Hash} hash
 * @param {TX} ref - Reference tx, the tx that double-spent.
 * @param {Function} callback - Returns [Error, Boolean].
 */

TXDB.prototype._removeConflict = function _removeConflict(hash, ref, callback) {
  var self = this;

  this.getTX(hash, function(err, tx) {
    if (err)
      return callback(err);

    if (!tx)
      return callback(new Error('Could not find spender.'));

    if (tx.ts !== 0) {
      // If spender is confirmed and replacement
      // is not confirmed, do nothing.
      if (ref.ts === 0)
        return callback();

      // If both are confirmed but replacement
      // is older than spender, do nothing.
      if (ref.ts < tx.ts)
        return callback();
    } else {
      // If spender is unconfirmed and replacement
      // is confirmed, do nothing.
      if (ref.ts !== 0)
        return callback();

      // If both are unconfirmed but replacement
      // is older than spender, do nothing.
      if (ref.ps < tx.ps)
        return callback();
    }

    self._removeRecursive(tx, function(err, result, info) {
      if (err)
        return callback(err);
      callback(null, tx, info);
    });
  });
};

/**
 * Remove a transaction and recursively
 * remove all of its spenders.
 * @private
 * @param {TX} tx - Transaction to be removed.
 * @param {Function} callback - Returns [Error, Boolean].
 */

TXDB.prototype._removeRecursive = function _removeRecursive(tx, callback) {
  var self = this;
  var hash = tx.hash('hex');

  utils.forEachSerial(tx.outputs, function(output, next, i) {
    self.isSpent(hash, i, function(err, spent) {
      if (err)
        return next(err);

      if (!spent)
        return next();

      // Remove all of the spender's spenders first.
      self.getTX(spent.hash, function(err, tx) {
        if (err)
          return next(err);

        if (!tx)
          return next(new Error('Could not find spender.'));

        self._removeRecursive(tx, next);
      });
    });
  }, function(err) {
    if (err)
      return callback(err);

    self.start();

    // Remove the spender.
    self._lazyRemove(tx, function(err, result, info) {
      if (err) {
        self.drop();
        return callback(err);
      }

      self.commit(function(err) {
        if (err)
          return callback(err);
        callback(null, result, info);
      });
    });
  });
};

/**
 * Test an entire transaction to see
 * if any of its outpoints are a double-spend.
 * @param {TX} tx
 * @param {Function} callback - Returns [Error, Boolean].
 */

TXDB.prototype.isDoubleSpend = function isDoubleSpend(tx, callback) {
  var self = this;

  utils.everySerial(tx.inputs, function(input, next) {
    var prevout = input.prevout;
    self.isSpent(prevout.hash, prevout.index, function(err, spent) {
      if (err)
        return next(err);
      return next(null, !spent);
    });
  }, function(err, result) {
    if (err)
      return callback(err);
    callback(null, !result);
  });
};

/**
 * Test a whether a coin has been spent.
 * @param {Hash} hash
 * @param {Number} index
 * @param {Function} callback - Returns [Error, Boolean].
 */

TXDB.prototype.isSpent = function isSpent(hash, index, callback) {
  var key = layout.s(hash, index);
  this.fetch(key, function(data) {
    return bcoin.outpoint.fromRaw(data);
  }, callback);
};

/**
 * Attempt to confirm a transaction.
 * @private
 * @param {TX} tx
 * @param {AddressMap} info
 * @param {Function} callback - Returns [Error, Boolean]. `false` if
 * the transaction should be added to the database, `true` if the
 * transaction was confirmed, or should be ignored.
 */

TXDB.prototype._confirm = function _confirm(tx, info, callback) {
  var self = this;
  var hash = tx.hash('hex');
  var i, account;

  this.getTX(hash, function(err, existing) {
    if (err)
      return callback(err);

    // Haven't seen this tx before, add it.
    if (!existing)
      return callback(null, false, info);

    // Existing tx is already confirmed. Ignore.
    if (existing.ts !== 0)
      return callback(null, true, info);

    // The incoming tx won't confirm the
    // existing one anyway. Ignore.
    if (tx.ts === 0)
      return callback(null, true, info);

    // Tricky - update the tx and coin in storage,
    // and remove pending flag to mark as confirmed.
    assert(tx.height >= 0);

    // Clear any locked coins to free up memory.
    self.unlockTX(tx);

    // Save the original received time.
    tx.ps = existing.ps;

    self.start();

    self.put(layout.t(hash), tx.toExtended());

    self.del(layout.p(hash));
    self.put(layout.h(tx.height, hash), DUMMY);

    for (i = 0; i < info.accounts.length; i++) {
      account = info.accounts[i];
      self.del(layout.P(account, hash));
      self.put(layout.H(account, tx.height, hash), DUMMY);
    }

    utils.forEachSerial(tx.outputs, function(output, next, i) {
      var address = output.getHash('hex');
      var key = hash + i;

      // Only update coins if this output is ours.
      if (!info.hasPath(address))
        return next();

      self.getCoin(hash, i, function(err, coin) {
        if (err)
          return next(err);

        // Update spent coin.
        if (!coin)
          return self.updateSpentCoin(tx, i, next);

        self.balance.confirm(coin.value);

        coin.height = tx.height;
        coin = coin.toRaw();

        self.put(layout.c(hash, i), coin);

        self.coinCache.set(key, coin);

        next();
      });
    }, function(err) {
      if (err) {
        self.drop();
        return callback(err);
      }

      self.commit(function(err) {
        if (err)
          return callback(err);

        self.emit('tx', tx, info);
        self.emit('confirmed', tx, info);

        callback(null, true, info);
      });
    });
  });
};

/**
 * Remove a transaction from the database. Disconnect inputs.
 * @param {Hash} hash
 * @param {Function} callback - Returns [Error].
 */

TXDB.prototype.remove = function remove(hash, callback, force) {
  var unlock = this._lock(remove, [hash, callback], force);

  if (!unlock)
    return;

  callback = utils.wrap(callback, unlock);

  this._removeRecursive(hash, function(err, result, info) {
    if (err)
      return callback(err);

    callback(null, !!result, info);
  });
};

/**
 * Remove a transaction from the database, but do not
 * look up the transaction. Use the passed-in transaction
 * to disconnect.
 * @param {TX} tx
 * @param {Function} callback - Returns [Error].
 */

TXDB.prototype._lazyRemove = function lazyRemove(tx, callback) {
  var self = this;
  this.getInfo(tx, function(err, info) {
    if (err)
      return callback(err);

    if (!info)
      return callback(null, false);

    self._remove(tx, info, callback);
  });
};

/**
 * Remove a transaction from the database. Disconnect inputs.
 * @private
 * @param {TX} tx
 * @param {AddressMap} info
 * @param {Function} callback - Returns [Error].
 */

TXDB.prototype._remove = function remove(tx, info, callback) {
  var self = this;
  var hash = tx.hash('hex');
  var i, path, account, key, address, input, output, coin;

  this.del(layout.t(hash));

  if (tx.ts === 0)
    this.del(layout.p(hash));
  else
    this.del(layout.h(tx.height, hash));

  this.del(layout.m(tx.ps, hash));

  for (i = 0; i < info.accounts.length; i++) {
    account = info.accounts[i];
    this.del(layout.T(account, hash));
    if (tx.ts === 0)
      this.del(layout.P(account, hash));
    else
      this.del(layout.H(account, tx.height, hash));
    this.del(layout.M(account, tx.ps, hash));
  }

  this.fillHistory(tx, function(err) {
    if (err)
      return callback(err);

    for (i = 0; i < tx.inputs.length; i++) {
      input = tx.inputs[i];
      key = input.prevout.hash + input.prevout.index;
      var prevout = input.prevout;
      address = input.getHash('hex');

      if (tx.isCoinbase())
        break;

      if (!input.coin)
        continue;

      path = info.getPath(address);

      if (!path)
        continue;

      self.balance.add(input.coin);

      coin = input.coin.toRaw();

      self.put(layout.c(prevout.hash, prevout.index), coin);
      self.put(layout.C(path.account, prevout.hash, prevout.index), DUMMY);
      self.del(layout.d(hash, i));
      self.del(layout.s(prevout.hash, prevout.index));
      self.del(layout.o(prevout.hash, prevout.index));

      self.coinCache.set(key, coin);
    }

    for (i = 0; i < tx.outputs.length; i++) {
      output = tx.outputs[i];
      key = hash + i;
      address = output.getHash('hex');

      path = info.getPath(address);

      if (!path)
        continue;

      coin = bcoin.coin.fromTX(tx, i);

      self.balance.sub(coin);

      self.del(layout.c(hash, i));
      self.del(layout.C(path.account, hash, i));

      self.coinCache.remove(key);
    }

    self.emit('remove tx', tx, info);

    callback(null, true, info);
  });
};

/**
 * Unconfirm a transaction. This is usually necessary after a reorg.
 * @param {Hash} hash
 * @param {Function} callback
 */

TXDB.prototype.unconfirm = function unconfirm(hash, callback, force) {
  var self = this;
  var unlock = this._lock(unconfirm, [hash, callback], force);

  if (!unlock)
    return;

  callback = utils.wrap(callback, unlock);

  this.getTX(hash, function(err, tx) {
    if (err)
      return callback(err);

    if (!tx)
      return callback(null, true);

    self.getInfo(tx, function(err, info) {
      if (err)
        return callback(err);

      if (!info)
        return callback(null, false);

      self.start();

      self._unconfirm(tx, info, function(err, result, info) {
        if (err) {
          self.drop();
          return callback(err);
        }

        self.commit(function(err) {
          if (err)
            return callback(err);
          callback(null, result, info);
        });
      });
    });
  });
};

/**
 * Unconfirm a transaction. This is usually necessary after a reorg.
 * @param {Hash} hash
 * @param {AddressMap} info
 * @param {Function} callback
 */

TXDB.prototype._unconfirm = function unconfirm(tx, info, callback, force) {
  var self = this;
  var hash = tx.hash('hex');
  var i, account;

  if (tx.height === -1)
    return callback(null, false, info);

  tx.height = -1;
  tx.ts = 0;
  tx.index = -1;
  tx.block = null;

  this.put(layout.t(hash), tx.toExtended());

  this.put(layout.p(hash), DUMMY);
  this.del(layout.h(height, hash));

  for (i = 0; i < info.accounts.length; i++) {
    account = info.accounts[i];
    this.put(layout.P(account, hash), DUMMY);
    this.del(layout.H(account, height, hash));
  }

  utils.forEachSerial(tx.outputs, function(output, next, i) {
    var key = hash + i;
    self.getCoin(hash, i, function(err, coin) {
      if (err)
        return next(err);

      // Update spent coin.
      if (!coin)
        return self.updateSpentCoin(tx, i, next);

      self.balance.unconfirm(coin.value);
      coin.height = tx.height;
      coin = coin.toRaw();

      self.put(layout.c(hash, i), coin);

      self.coinCache.set(key, coin);

      next();
    });
  }, function(err) {
    if (err)
      return callback(err);

    self.emit('unconfirmed', tx, info);

    callback(null, true, info);
  });
};

/**
 * Lock all coins in a transaction.
 * @param {TX} tx
 */

TXDB.prototype.lockTX = function lockTX(tx) {
  var i, input;

  if (tx.isCoinbase())
    return;

  for (i = 0; i < tx.inputs.length; i++) {
    input = tx.inputs[i];
    this.lockCoin(input.prevout);
  }
};

/**
 * Unlock all coins in a transaction.
 * @param {TX} tx
 */

TXDB.prototype.unlockTX = function unlockTX(tx) {
  var i, input;

  if (tx.isCoinbase())
    return;

  for (i = 0; i < tx.inputs.length; i++) {
    input = tx.inputs[i];
    this.unlockCoin(input.prevout);
  }
};

/**
 * Lock a single coin.
 * @param {Coin|Outpoint} coin
 */

TXDB.prototype.lockCoin = function lockCoin(coin) {
  var key = coin.hash + coin.index;
  this.locked[key] = true;
};

/**
 * Unlock a single coin.
 * @param {Coin|Outpoint} coin
 */

TXDB.prototype.unlockCoin = function unlockCoin(coin) {
  var key = coin.hash + coin.index;
  delete this.locked[key];
};

/**
 * Test locked status of a single coin.
 * @param {Coin|Outpoint} coin
 */

TXDB.prototype.isLocked = function isLocked(coin) {
  var key = coin.hash + coin.index;
  return this.locked[key] === true;
};

/**
 * Filter array of coins or outpoints
 * for only unlocked ones.
 * @param {Coin[]|Outpoint[]}
 * @returns {Array}
 */

TXDB.prototype.filterLocked = function filterLocked(coins) {
  var out = [];
  var i, coin;

  for (i = 0; i < coins.length; i++) {
    coin = coins[i];
    if (!this.isLocked(coin))
      out.push(coins);
  }

  return coins;
};

/**
 * Return an array of all locked outpoints.
 * @returns {Outpoint[]}
 */

TXDB.prototype.getLocked = function getLocked() {
  var keys = Object.keys(this.locked);
  var outpoints = [];
  var i, key, hash, index, outpoint;

  for (i = 0; i < keys.length; i++) {
    key = keys[i];
    hash = key.slice(0, 64);
    index = +key.slice(64);
    outpoint = new bcoin.outpoint(hash, index);
    outpoints.push(outpoint);
  }

  return outpoints;
};

/**
 * Get hashes of all transactions in the database.
 * @param {Number?} account
 * @param {Function} callback - Returns [Error, {@link Hash}[]].
 */

TXDB.prototype.getHistoryHashes = function getHistoryHashes(account, callback) {
  if (typeof account === 'function') {
    callback = account;
    account = null;
  }

  this.iterate({
    gte: account != null
      ? layout.T(account, constants.NULL_HASH)
      : layout.t(constants.NULL_HASH),
    lte: account != null
      ? layout.T(account, constants.HIGH_HASH)
      : layout.t(constants.HIGH_HASH),
    parse: function(key) {
      if (account != null) {
        key = layout.Tt(key);
        return key[1];
      }
      key = layout.tt(key);
      return key;
    }
  }, callback);
};

/**
 * Get hashes of all unconfirmed transactions in the database.
 * @param {Number?} account
 * @param {Function} callback - Returns [Error, {@link Hash}[]].
 */

TXDB.prototype.getUnconfirmedHashes = function getUnconfirmedHashes(account, callback) {
  if (typeof account === 'function') {
    callback = account;
    account = null;
  }

  this.iterate({
    gte: account != null
      ? layout.P(account, constants.NULL_HASH)
      : layout.p(constants.NULL_HASH),
    lte: account != null
      ? layout.P(account, constants.HIGH_HASH)
      : layout.p(constants.HIGH_HASH),
    parse: function(key) {
      if (account != null) {
        key = layout.Pp(key);
        return key[1];
      }
      key = layout.pp(key);
      return key;
    }
  }, callback);
};

/**
 * Get all coin hashes in the database.
 * @param {Number?} account
 * @param {Function} callback - Returns [Error, {@link Hash}[]].
 */

TXDB.prototype.getCoinHashes = function getCoinHashes(account, callback) {
  if (typeof account === 'function') {
    callback = account;
    account = null;
  }

  this.iterate({
    gte: account != null
      ? layout.C(account, constants.NULL_HASH, 0)
      : layout.c(constants.NULL_HASH, 0),
    lte: account != null
      ? layout.C(account, constants.HIGH_HASH, 0xffffffff)
      : layout.c(constants.HIGH_HASH, 0xffffffff),
    parse: function(key) {
      if (account != null) {
        key = layout.Cc(key);
        return [key[1], key[2]];
      }
      key = layout.cc(key);
      return key;
    }
  }, callback);
};

/**
 * Get TX hashes by height range.
 * @param {Number?} account
 * @param {Object} options
 * @param {Number} options.start - Start height.
 * @param {Number} options.end - End height.
 * @param {Number?} options.limit - Max number of records.
 * @param {Boolean?} options.reverse - Reverse order.
 * @param {Function} callback - Returns [Error, {@link Hash}[]].
 */

TXDB.prototype.getHeightRangeHashes = function getHeightRangeHashes(account, options, callback) {
  var start, end;

  if (typeof account !== 'number') {
    callback = options;
    options = account;
    account = null;
  }

  start = options.start || 0;
  end = options.end || 0xffffffff;

  this.iterate({
    gte: account != null
      ? layout.H(account, start, constants.NULL_HASH)
      : layout.h(start, constants.NULL_HASH),
    lte: account != null
      ? layout.H(account, end, constants.HIGH_HASH)
      : layout.h(end, constants.HIGH_HASH),
    limit: options.limit,
    reverse: options.reverse,
    parse: function(key) {
      if (account != null) {
        key = layout.Hh(key);
        return key[2];
      }
      key = layout.hh(key);
      return key[1];
    }
  }, callback);
};

/**
 * Get TX hashes by height.
 * @param {Number} height
 * @param {Function} callback - Returns [Error, {@link Hash}[]].
 */

TXDB.prototype.getHeightHashes = function getHeightHashes(height, callback) {
  this.getHeightRangeHashes({ start: height, end: height }, callback);
};

/**
 * Get TX hashes by timestamp range.
 * @param {Number?} account
 * @param {Object} options
 * @param {Number} options.start - Start height.
 * @param {Number} options.end - End height.
 * @param {Number?} options.limit - Max number of records.
 * @param {Boolean?} options.reverse - Reverse order.
 * @param {Function} callback - Returns [Error, {@link Hash}[]].
 */

TXDB.prototype.getRangeHashes = function getRangeHashes(account, options, callback) {
  var start, end;

  if (typeof account === 'function') {
    callback = account;
    account = null;
  }

  start = options.start || 0;
  end = options.end || 0xffffffff;

  this.iterate({
    gte: account != null
      ? layout.M(account, start, constants.NULL_HASH)
      : layout.m(start, constants.NULL_HASH),
    lte: account != null
      ? layout.M(account, end, constants.HIGH_HASH)
      : layout.m(end, constants.HIGH_HASH),
    limit: options.limit,
    reverse: options.reverse,
    parse: function(key) {
      if (account != null) {
        key = layout.Mm(key);
        return key[2];
      }
      key = layout.mm(key);
      return key[1];
    }
  }, callback);
};

/**
 * Get transactions by timestamp range.
 * @param {Number?} account
 * @param {Object} options
 * @param {Number} options.start - Start time.
 * @param {Number} options.end - End time.
 * @param {Number?} options.limit - Max number of records.
 * @param {Boolean?} options.reverse - Reverse order.
 * @param {Function} callback - Returns [Error, {@link TX}[]].
 */

TXDB.prototype.getRange = function getRange(account, options, callback) {
  var self = this;
  var txs = [];

  if (typeof account === 'function') {
    callback = account;
    account = null;
  }

  this.getRangeHashes(account, options, function(err, hashes) {
    if (err)
      return callback(err);

    utils.forEachSerial(hashes, function(hash, next) {
      self.getTX(hash, function(err, tx) {
        if (err)
          return callback(err);

        if (!tx)
          return next();

        txs.push(tx);

        next();
      });
    }, function(err) {
      if (err)
        return callback(err);

      callback(null, txs);
    });
  });
};

/**
 * Get last N transactions.
 * @param {Number?} account
 * @param {Number} limit - Max number of transactions.
 * @param {Function} callback - Returns [Error, {@link TX}[]].
 */

TXDB.prototype.getLast = function getLast(account, limit, callback) {
  if (typeof limit === 'function') {
    callback = limit;
    limit = account;
    account = null;
  }

  this.getRange(account, {
    start: 0,
    end: 0xffffffff,
    reverse: true,
    limit: limit
  }, callback);
};

/**
 * Get all transactions.
 * @param {Number?} account
 * @param {Function} callback - Returns [Error, {@link TX}[]].
 */

TXDB.prototype.getHistory = function getHistory(account, callback) {
  if (typeof account === 'function') {
    callback = account;
    account = null;
  }

  // Slow case
  if (account != null)
    return this.getAccountHistory(account, callback);

  // Fast case
  this.iterate({
    gte: layout.t(constants.NULL_HASH),
    lte: layout.t(constants.HIGH_HASH),
    keys: false,
    values: true,
    parse: function(key, value) {
      return bcoin.tx.fromExtended(value);
    }
  }, callback);
};

/**
 * Get all account transactions.
 * @param {Number?} account
 * @param {Function} callback - Returns [Error, {@link TX}[]].
 */

TXDB.prototype.getAccountHistory = function getAccountHistory(account, callback) {
  var self = this;
  var txs = [];

  if (typeof account === 'function') {
    callback = account;
    account = null;
  }

  this.getHistoryHashes(account, function(err, hashes) {
    if (err)
      return callback(err);

    utils.forEachSerial(hashes, function(hash, next) {
      self.getTX(hash, function(err, tx) {
        if (err)
          return callback(err);

        if (!tx)
          return next();

        txs.push(tx);

        next();
      });
    }, function(err) {
      if (err)
        return callback(err);

      callback(null, sortTX(txs));
    });
  });
};

/**
 * Get last active timestamp and height.
 * @param {Number?} account
 * @param {Function} callback - Returns [Error, Number(ts), Number(height)].
 */

TXDB.prototype.getLastTime = function getLastTime(account, callback) {
  var i, tx, lastTs, lastHeight;

  if (typeof account === 'function') {
    callback = account;
    account = null;
  }

  this.getHistory(account, function(err, txs) {
    if (err)
      return callback(err);

    lastTs = 0;
    lastHeight = -1;

    for (i = 0; i < txs.length; i++) {
      tx = txs[i];

      if (tx.ts > lastTs)
        lastTs = tx.ts;

      if (tx.height > lastHeight)
        lastHeight = tx.height;
    }

    callback(null, lastTs, lastHeight);
  });
};

/**
 * Get unconfirmed transactions.
 * @param {Number?} account
 * @param {Function} callback - Returns [Error, {@link TX}[]].
 */

TXDB.prototype.getUnconfirmed = function getUnconfirmed(account, callback) {
  var self = this;
  var txs = [];

  if (typeof account === 'function') {
    callback = account;
    account = null;
  }

  this.getUnconfirmedHashes(account, function(err, hashes) {
    if (err)
      return callback(err);

    utils.forEachSerial(hashes, function(hash, next) {
      self.getTX(hash, function(err, tx) {
        if (err)
          return callback(err);

        if (!tx)
          return next();

        txs.push(tx);

        next();
      });
    }, function(err) {
      if (err)
        return callback(err);

      callback(null, sortTX(txs));
    });
  });
};

/**
 * Get coins.
 * @param {Number?} account
 * @param {Function} callback - Returns [Error, {@link Coin}[]].
 */

TXDB.prototype.getCoins = function getCoins(account, callback) {
  var self = this;

  if (typeof account === 'function') {
    callback = account;
    account = null;
  }

  // Slow case
  if (account != null)
    return this.getAccountCoins(account, callback);

  // Fast case
  this.iterate({
    gte: layout.c(constants.NULL_HASH, 0),
    lte: layout.c(constants.HIGH_HASH, 0xffffffff),
    values: true,
    parse: function(key, value) {
      var parts = layout.cc(key);
      var hash = parts[0];
      var index = parts[1];
      var coin = bcoin.coin.fromRaw(value);
      coin.hash = hash;
      coin.index = index;
      key = hash + index;
      self.coinCache.set(key, value);
      return coin;
    }
  }, callback);
};

/**
 * Get coins by account.
 * @param {Number} account
 * @param {Function} callback - Returns [Error, {@link Coin}[]].
 */

TXDB.prototype.getAccountCoins = function getCoins(account, callback) {
  var self = this;
  var coins = [];

  this.getCoinHashes(account, function(err, hashes) {
    if (err)
      return callback(err);

    utils.forEachSerial(hashes, function(key, next) {
      self.getCoin(key[0], key[1], function(err, coin) {
        if (err)
          return callback(err);

        if (!coin)
          return next();

        coins.push(coin);

        next();
      });
    }, function(err) {
      if (err)
        return callback(err);

      callback(null, coins);
    });
  });
};

/**
 * Fill a transaction with coins (all historical coins).
 * @param {TX} tx
 * @param {Function} callback - Returns [Error, {@link TX}].
 */

TXDB.prototype.fillHistory = function fillHistory(tx, callback) {
  var hash;

  if (tx.isCoinbase()) {
    callback = utils.asyncify(callback);
    return callback(null, tx);
  }

  hash = tx.hash('hex');

  this.iterate({
    gte: layout.d(hash, 0),
    lte: layout.d(hash, 0xffffffff),
    values: true,
    parse: function(key, value) {
      var index = layout.dd(key)[1];
      var coin = bcoin.coin.fromRaw(value);
      var input = tx.inputs[index];
      coin.hash = input.prevout.hash;
      coin.index = input.prevout.index;
      input.coin = coin;
    }
  }, function(err) {
    if (err)
      return callback(err);
    callback(null, tx);
  });
};

/**
 * Fill a transaction with coins.
 * @param {TX} tx
 * @param {Function} callback - Returns [Error, {@link TX}].
 */

TXDB.prototype.fillCoins = function fillCoins(tx, callback) {
  var self = this;

  if (tx.isCoinbase()) {
    callback = utils.asyncify(callback);
    return callback(null, tx);
  }

  utils.forEachSerial(tx.inputs, function(input, next) {
    var prevout = input.prevout;

    if (input.coin)
      return next();

    self.getCoin(prevout.hash, prevout.index, function(err, coin) {
      if (err)
        return callback(err);

      if (coin)
        input.coin = coin;

      next();
    });
  }, function(err) {
    if (err)
      return callback(err);
    callback(null, tx);
  });
};

/**
 * Get transaction.
 * @param {Hash} hash
 * @param {Function} callback - Returns [Error, {@link TX}].
 */

TXDB.prototype.getTX = function getTX(hash, callback) {
  this.fetch(layout.t(hash), function(tx) {
    return bcoin.tx.fromExtended(tx);
  }, callback);
};

/**
 * Get transaction details.
 * @param {Hash} hash
 * @param {Function} callback - Returns [Error, {@link TXDetails}].
 */

TXDB.prototype.getDetails = function getDetails(hash, callback) {
  var self = this;
  this.getTX(hash, function(err, tx) {
    if (err)
      return callback(err);

    if (!tx)
      return callback();

    self.toDetails(tx, callback);
  });
};

/**
 * Convert transaction to transaction details.
 * @param {TX|TX[]} tx
 * @param {Function} callback
 */

TXDB.prototype.toDetails = function toDetails(tx, callback) {
  var self = this;
  var out;

  if (Array.isArray(tx)) {
    out = [];
    return utils.forEachSerial(tx, function(tx, next) {
      self.toDetails(tx, function(err, details) {
        if (err)
          return next(err);

        if (!details)
          return next();

        out.push(details);
        next();
      });
    }, function(err) {
      if (err)
        return callback(err);
      callback(null, out);
    });
  }

  this.fillHistory(tx, function(err) {
    if (err)
      return callback(err);

    self.getInfo(tx, function(err, info) {
      if (err)
        return callback(err);

      if (!info)
        return callback(new Error('Info not found.'));

      callback(null, info.toDetails());
    });
  });
};

/**
 * Test whether the database has a transaction.
 * @param {Hash} hash
 * @param {Function} callback - Returns [Error, Boolean].
 */

TXDB.prototype.hasTX = function hasTX(hash, callback) {
  this.has(layout.t(hash), callback);
};

/**
 * Get coin.
 * @param {Hash} hash
 * @param {Number} index
 * @param {Function} callback - Returns [Error, {@link Coin}].
 */

TXDB.prototype.getCoin = function getCoin(hash, index, callback) {
  var self = this;
  var key = hash + index;
  var coin = this.coinCache.get(key);

  if (coin) {
    try {
      coin = bcoin.coin.fromRaw(coin);
    } catch (e) {
      return callback(e);
    }
    coin.hash = hash;
    coin.index = index;
    return callback(null, coin);
  }

  this.fetch(layout.c(hash, index), function(data) {
    var coin = bcoin.coin.fromRaw(data);
    coin.hash = hash;
    coin.index = index;
    self.coinCache.set(key, data);
    return coin;
  }, callback);
};

/**
 * Get spender coin.
 * @param {Outpoint} spent
 * @param {Outpoint} prevout
 * @param {Function} callback - Returns [Error, {@link Coin}].
 */

TXDB.prototype.getSpentCoin = function getSpentCoin(spent, prevout, callback) {
  this.fetch(layout.d(spent.hash, spent.index), function(data) {
    var coin = bcoin.coin.fromRaw(data);
    coin.hash = prevout.hash;
    coin.index = prevout.index;
    return coin;
  }, callback);
};

/**
 * Update spent coin height in storage.
 * @param {TX} tx - Sending transaction.
 * @param {Number} index
 * @param {Function} callback
 */

TXDB.prototype.updateSpentCoin = function updateSpentCoin(tx, i, callback) {
  var self = this;
  var prevout = bcoin.outpoint.fromTX(tx, i);
  this.isSpent(prevout.hash, prevout.index, function(err, spent) {
    if (err)
      return callback(err);

    if (!spent)
      return callback();

    self.getSpentCoin(spent, prevout, function(err, coin) {
      if (err)
        return callback(err);

      if (!coin)
        return callback();

      coin.height = tx.height;

      self.put(layout.d(spent.hash, spent.index), coin.toRaw());

      callback();
    });
  });
};

/**
 * Test whether the database has a transaction.
 * @param {Hash} hash
 * @param {Function} callback - Returns [Error, Boolean].
 */

TXDB.prototype.hasCoin = function hasCoin(hash, index, callback) {
  var key = hash + index;

  if (this.coinCache.has(key))
    return callback(null, true);

  this.has(layout.c(hash, index), callback);
};

/**
 * Calculate balance.
 * @param {Number?} account
 * @param {Function} callback - Returns [Error, {@link Balance}].
 */

TXDB.prototype.getBalance = function getBalance(account, callback) {
  var self = this;
  var balance;

  if (typeof account === 'function') {
    callback = account;
    account = null;
  }

  // Slow case
  if (account != null)
    return this.getAccountBalance(account, callback);

  // Really fast case
  if (this.balance)
    return callback(null, this.balance);

  // Fast case
  balance = new Balance(this.wallet);

  this.iterate({
    gte: layout.c(constants.NULL_HASH, 0),
    lte: layout.c(constants.HIGH_HASH, 0xffffffff),
    values: true,
    parse: function(key, data) {
      var parts = layout.cc(key);
      var hash = parts[0];
      var index = parts[1];
      var height = data.readUInt32LE(4, true);
      var value = utils.read64N(data, 8);

      assert(data.length >= 16);

      balance.total += value;

      if (height === 0x7fffffff)
        balance.unconfirmed += value;
      else
        balance.confirmed += value;

      key = hash + index;

      self.coinCache.set(key, data);
    }
  }, function(err) {
    if (err)
      return callback(err);

    callback(null, balance);
  });
};

/**
 * Calculate balance by account.
 * @param {Number} account
 * @param {Function} callback - Returns [Error, {@link Balance}].
 */

TXDB.prototype.getAccountBalance = function getBalance(account, callback) {
  var self = this;
  var balance = new Balance(this.wallet);
  var key, coin;

  function parse(data) {
    var height = data.readUInt32LE(4, true);
    var value = utils.read64N(data, 8);

    assert(data.length >= 16);

    balance.total += value;

    if (height === 0x7fffffff)
      balance.unconfirmed += value;
    else
      balance.confirmed += value;
  }

  this.getCoinHashes(account, function(err, hashes) {
    if (err)
      return callback(err);

    utils.forEachSerial(hashes, function(hash, next) {
      key = hash[0] + hash[1];
      coin = self.coinCache.get(key);

      if (coin) {
        try {
          parse(coin);
        } catch (e) {
          return next(e);
        }
        return next();
      }

      self.get(layout.c(hash[0], hash[1]), function(err, data) {
        if (err)
          return next(err);

        if (!data)
          return next();

        try {
          parse(data);
        } catch (e) {
          return callback(e);
        }

        self.coinCache.set(key, data);

        next();
      });
    }, function(err) {
      if (err)
        return callback(err);

      callback(null, balance);
    });
  });
};

/**
 * @param {Number?} account
 * @param {Number} age - Age delta (delete transactions older than `now - age`).
 * @param {Function} callback
 */

TXDB.prototype.zap = function zap(account, age, callback, force) {
  var self = this;
  var unlock;

  if (typeof age === 'function') {
    force = callback;
    callback = age;
    age = account;
    account = null;
  }

  unlock = this._lock(zap, [account, age, callback], force);

  if (!unlock)
    return;

  callback = utils.wrap(callback, unlock);

  if (!utils.isUInt32(age))
    return callback(new Error('Age must be a number.'));

  this.getRange(account, {
    start: 0,
    end: bcoin.now() - age
  }, function(err, txs) {
    if (err)
      return callback(err);

    utils.forEachSerial(txs, function(tx, next) {
      if (tx.ts !== 0)
        return next();
      self.remove(tx.hash('hex'), next, true);
    }, callback);
  });
};

/**
 * Abandon transaction.
 * @param {Hash} hash
 * @param {Function} callback
 */

TXDB.prototype.abandon = function abandon(hash, callback, force) {
  var self = this;
  this.has(layout.p(hash), function(err, result) {
    if (err)
      return callback(err);

    if (!result)
      return callback(new Error('TX not eligible.'));

    self.remove(hash, callback, force);
  });
};

/**
 * Details
 */

function Details(info) {
  if (!(this instanceof Details))
    return new Details(info);

  this.db = info.db;
  this.network = info.db.network;
  this.wid = info.wid;
  this.id = info.id;
  this.hash = info.tx.hash('hex');
  this.height = info.tx.height;
  this.block = info.tx.block;
  this.index = info.tx.index;
  this.confirmations = info.tx.getConfirmations(this.db.height);
  this.fee = info.tx.getFee();
  this.ts = info.tx.ts;
  this.ps = info.tx.ps;
  this.tx = info.tx;
  this.inputs = [];
  this.outputs = [];

  this.init(info.table);
}

Details.prototype.init = function init(table) {
  this._insert(this.tx.inputs, this.inputs, table);
  this._insert(this.tx.outputs, this.outputs, table);
};

Details.prototype._insert = function _insert(vector, target, table) {
  var i, j, io, address, hash, paths, path, member;

  for (i = 0; i < vector.length; i++) {
    io = vector[i];
    member = new DetailsMember();

    if (io instanceof bcoin.input)
      member.value = io.coin ? io.coin.value : 0;
    else
      member.value = io.value;

    address = io.getAddress();

    if (address) {
      member.address = address;

      hash = address.getHash('hex');
      paths = table[hash];

      for (j = 0; j < paths.length; j++) {
        path = paths[j];
        if (path.wid === this.wid) {
          path.id = this.id;
          member.path = path;
          break;
        }
      }
    }

    target.push(member);
  }
};

Details.prototype.toJSON = function toJSON() {
  var self = this;
  return {
    wid: this.wid,
    id: this.id,
    hash: utils.revHex(this.hash),
    height: this.height,
    block: this.block ? utils.revHex(this.block) : null,
    ts: this.ts,
    ps: this.ps,
    index: this.index,
    fee: utils.btc(this.fee),
    confirmations: this.confirmations,
    inputs: this.inputs.map(function(input) {
      return input.toJSON(self.network);
    }),
    outputs: this.outputs.map(function(output) {
      return output.toJSON(self.network);
    }),
    tx: this.tx.toRaw().toString('hex')
  };
};

/**
 * DetailsMember
 */

function DetailsMember() {
  if (!(this instanceof DetailsMember))
    return new DetailsMember();

  this.value = 0;
  this.address = null;
  this.path = null;
}

DetailsMember.prototype.toJSON = function toJSON(network) {
  return {
    value: utils.btc(this.value),
    address: this.address
      ? this.address.toBase58(network)
      : null,
    path: this.path
      ? this.path.toJSON()
      : null
  };
};

/*
 * Balance
 */

function Balance(wallet) {
  if (!(this instanceof Balance))
    return new Balance(wallet);

  this.wid = wallet.wid;
  this.id = wallet.id;
  this.unconfirmed = 0;
  this.confirmed = 0;
  this.total = 0;
}

Balance.prototype.add = function add(coin) {
  this.total += coin.value;
  if (coin.height === -1)
    this.unconfirmed += coin.value;
  else
    this.confirmed += coin.value;
};

Balance.prototype.sub = function sub(coin) {
  this.total -= coin.value;
  if (coin.height === -1)
    this.unconfirmed -= coin.value;
  else
    this.confirmed -= coin.value;
};

Balance.prototype.confirm = function confirm(value) {
  this.unconfirmed -= value;
  this.confirmed += value;
};

Balance.prototype.unconfirm = function unconfirm(value) {
  this.unconfirmed += value;
  this.confirmed -= value;
};

Balance.prototype.toJSON = function toJSON() {
  return {
    wid: this.wid,
    id: this.id,
    unconfirmed: utils.btc(this.unconfirmed),
    confirmed: utils.btc(this.confirmed),
    total: utils.btc(this.total)
  };
};

Balance.prototype.toString = function toString() {
  return '<Balance'
    + ' unconfirmed=' + utils.btc(this.unconfirmed)
    + ' confirmed=' + utils.btc(this.confirmed)
    + ' total=' + utils.btc(this.total)
    + '>';
};

/*
 * Helpers
 */

function sortTX(txs) {
  return txs.sort(function(a, b) {
    return a.ps - b.ps;
  });
}

function sortCoins(coins) {
  return coins.sort(function(a, b) {
    a = a.height === -1 ? 0x7fffffff : a.height;
    b = b.height === -1 ? 0x7fffffff : b.height;
    return a - b;
  });
}

/*
 * Expose
 */

TXDB.Details = Details;
module.exports = TXDB;
