/*!
 * coins.js - coins object for bcoin
 * Copyright (c) 2014-2015, Fedor Indutny (MIT License)
 * Copyright (c) 2014-2016, Christopher Jeffrey (MIT License).
 * https://github.com/bcoin-org/bcoin
 */

'use strict';

var bcoin = require('./env');
var utils = bcoin.utils;
var assert = utils.assert;
var constants = bcoin.protocol.constants;
var BufferReader = require('./reader');
var BufferWriter = require('./writer');

/**
 * Represents the outputs for a single transaction.
 * @exports Coins
 * @constructor
 * @param {TX|Object} tx/options - TX or options object.
 * @property {Hash} hash - Transaction hash.
 * @property {Number} version - Transaction version.
 * @property {Number} height - Transaction height (-1 if unconfirmed).
 * @property {Boolean} coinbase - Whether the containing
 * transaction is a coinbase.
 * @property {Coin[]} outputs - Coins.
 */

function Coins(options) {
  if (!(this instanceof Coins))
    return new Coins(options);

  this.version = 1;
  this.hash = constants.NULL_HASH;
  this.height = -1;
  this.coinbase = true;
  this.outputs = [];

  if (options)
    this.fromOptions(options);
}

/**
 * Inject properties from options object.
 * @private
 * @param {Object} options
 */

Coins.prototype.fromOptions = function fromOptions(options) {
  if (options.version != null)
    this.version = options.version;

  if (options.hash)
    this.hash = options.hash;

  if (options.height != null)
    this.height = options.height;

  if (options.coinbase != null)
    this.coinbase = options.coinbase;

  if (options.outputs)
    this.outputs = options.outputs;

  return this;
};

/**
 * Instantiate coins from options object.
 * @param {Object} options
 * @returns {Coins}
 */

Coins.fromOptions = function fromOptions(options) {
  return new Coins().fromOptions(options);
};

/**
 * Add a single coin to the collection.
 * @param {Coin} coin
 */

Coins.prototype.add = function add(coin) {
  if (this.outputs.length === 0) {
    this.version = coin.version;
    this.hash = coin.hash;
    this.height = coin.height;
    this.coinbase = coin.coinbase;
  }

  while (this.outputs.length <= coin.index)
    this.outputs.push(null);

  if (coin.script.isUnspendable()) {
    this.outputs[coin.index] = null;
    return;
  }

  this.outputs[coin.index] = coin;
};

/**
 * Test whether the collection has a coin.
 * @param {Number} index
 * @returns {Boolean}
 */

Coins.prototype.has = function has(index) {
  return this.outputs[index] != null;
};

/**
 * Get a coin.
 * @param {Number} index
 * @returns {Coin}
 */

Coins.prototype.get = function get(index) {
  var coin = this.outputs[index];
  if (!coin)
    return;

  if (coin instanceof DeferredCoin)
    coin = coin.toCoin(this, index);

  return coin;
};

/**
 * Count unspent coins.
 * @returns {Number}
 */

Coins.prototype.count = function count(index) {
  var total = 0;
  var i;

  for (i = 0; i < this.outputs.length; i++) {
    if (this.outputs[i])
      total++;
  }

  return total;
};

/**
 * Remove a coin and return it.
 * @param {Number} index
 * @returns {Coin}
 */

Coins.prototype.spend = function spend(index) {
  var coin = this.get(index);
  this.outputs[index] = null;
  return coin;
};

/**
 * Serialize the coins object.
 * @param {TX|Coins} tx
 * @returns {Buffer}
 */

Coins.prototype.toRaw = function toRaw(writer) {
  var p = new BufferWriter(writer);
  var height = this.height;
  var i, output, prefix, hash, coinbase, mask;

  if (height === -1)
    height = 0x7fffffff;

  coinbase = this.coinbase;

  mask = (height << 1) | (coinbase ? 1 : 0);

  p.writeVarint(this.version);
  p.writeU32(mask >>> 0);

  for (i = 0; i < this.outputs.length; i++) {
    output = this.outputs[i];

    if (!output) {
      p.writeU8(0xff);
      continue;
    }

    if (output instanceof DeferredCoin) {
      p.writeBytes(output.toRaw());
      continue;
    }

    prefix = 0;

    // Saves up to 7 bytes.
    if (output.script.isPubkeyhash()) {
      prefix = 1;
      hash = output.script.code[2].data;
    } else if (output.script.isScripthash()) {
      prefix = 2;
      hash = output.script.code[1].data;
    }

    p.writeU8(prefix);

    if (prefix)
      p.writeBytes(hash);
    else
      p.writeVarBytes(output.script.toRaw());

    p.writeVarint(output.value);
  }

  if (!writer)
    p = p.render();

  return p;
};

/**
 * Parse serialized coins.
 * @param {Buffer} data
 * @param {Hash} hash
 * @returns {Object} A "naked" coins object.
 */

Coins.prototype.fromRaw = function fromRaw(data, hash, index) {
  var p = new BufferReader(data);
  var i = 0;
  var version, height, coin, mask, prefix, offset, size;

  version = p.readVarint();
  height = p.readU32();

  this.version = version;
  this.height = height >>> 1;
  this.hash = hash;
  this.coinbase = (height & 1) !== 0;

  if (this.height === 0x7fffffff)
    this.height = -1;

  while (p.left()) {
    offset = p.start();
    mask = p.readU8();

    if (mask === 0xff) {
      p.end();
      if (index != null) {
        if (i === index)
          return;
        i++;
        continue;
      }
      this.outputs.push(null);
      i++;
      continue;
    }

    prefix = mask & 3;

    if (prefix === 0)
      p.seek(p.readVarint());
    else if (prefix <= 2)
      p.seek(20);
    else
      assert(false, 'Bad prefix.');

    p.readVarint();

    size = p.end();

    if (index != null && i !== index) {
      i++;
      continue;
    }

    coin = new DeferredCoin(offset, size, data);

    if (index != null)
      return coin.toCoin(this, i);

    this.outputs.push(coin);

    i++;
  }

  assert(index == null, 'Bad coin index.');

  return this;
};

/**
 * Parse a single serialized coin.
 * @param {Buffer} data
 * @param {Hash} hash
 * @param {Number} index
 * @returns {Coin}
 */

Coins.parseCoin = function parseCoin(data, hash, index) {
  assert(index != null, 'Bad coin index.');
  return new Coins().fromRaw(data, hash, index);
};

/**
 * Instantiate coins from a serialized Buffer.
 * @param {Buffer} data
 * @param {Hash} hash - Transaction hash.
 * @returns {Coins}
 */

Coins.fromRaw = function fromRaw(data, hash) {
  return new Coins().fromRaw(data, hash);
};

/**
 * Inject properties from tx.
 * @private
 * @param {TX} tx
 */

Coins.prototype.fromTX = function fromTX(tx) {
  var i;

  this.version = tx.version;
  this.hash = tx.hash('hex');
  this.height = tx.height;
  this.coinbase = tx.isCoinbase();

  for (i = 0; i < tx.outputs.length; i++) {
    if (tx.outputs[i].script.isUnspendable()) {
      this.outputs.push(null);
      continue;
    }
    this.outputs.push(bcoin.coin.fromTX(tx, i));
  }

  return this;
};

/**
 * Instantiate a coins object from a transaction.
 * @param {TX} tx
 * @returns {Coins}
 */

Coins.fromTX = function fromTX(tx) {
  return new Coins().fromTX(tx);
};

/**
 * A "deferred" coin is an object which defers
 * parsing of a compressed coin. Say there is
 * a transaction with 100 outputs. When a block
 * comes in, there may only be _one_ input in
 * that entire block which redeems an output
 * from that transaction. When parsing the
 * Coins, there is no sense to get _all_ of
 * them into their abstract form. A deferred
 * coin is just a pointer to that coin in the
 * Coins buffer, as well as a size. Parsing
 * is done only if that coin is being redeemed.
 * @constructor
 * @private
 * @param {Number} offset
 * @param {Number} size
 * @param {Buffer} raw
 */

function DeferredCoin(offset, size, raw) {
  if (!(this instanceof DeferredCoin))
    return new DeferredCoin(offset, size, raw);

  this.offset = offset;
  this.size = size;
  this.raw = raw;
}

/**
 * Parse the deferred data and return a Coin.
 * @param {Coins} coins
 * @param {Number} index
 * @returns {Coin}
 */

DeferredCoin.prototype.toCoin = function toCoin(coins, index) {
  var p = new BufferReader(this.raw);
  var coin = new bcoin.coin();
  var prefix;

  coin.version = coins.version;
  coin.coinbase = coins.coinbase;
  coin.height = coins.height;
  coin.hash = coins.hash;
  coin.index = index;

  p.seek(this.offset);

  prefix = p.readU8() & 3;

  switch (prefix) {
    case 0:
      coin.script.fromRaw(p.readVarBytes());
      break;
    case 1:
      coin.script.fromPubkeyhash(p.readBytes(20));
      break;
    case 2:
      coin.script.fromScripthash(p.readBytes(20));
      break;
    default:
      assert(false, 'Bad prefix.');
  }

  coin.value = p.readVarint();

  return coin;
};

/**
 * Slice off the part of the buffer
 * relevant to this particular coin.
 * @returns {Buffer}
 */

DeferredCoin.prototype.toRaw = function toRaw() {
  return this.raw.slice(this.offset, this.offset + this.size);
};

/*
 * Expose
 */

module.exports = Coins;
