/*!
 * input.js - input object for bcoin
 * Copyright (c) 2014-2015, Fedor Indutny (MIT License)
 * Copyright (c) 2014-2016, Christopher Jeffrey (MIT License).
 * https://github.com/bcoin-org/bcoin
 */

'use strict';

var bcoin = require('./env');
var utils = require('./utils');
var assert = utils.assert;
var constants = bcoin.protocol.constants;

/**
 * Represents a COutPoint.
 * @exports Outpoint
 * @constructor
 * @param {Hash?} hash
 * @param {Number?} index
 * @property {Hash} hash
 * @property {Number} index
 */

function Outpoint(hash, index) {
  if (!(this instanceof Outpoint))
    return new Outpoint(hash, index);

  this.hash = hash || constants.NULL_HASH;
  this.index = index != null ? index : 0xffffffff;
}

/**
 * Inject properties from options object.
 * @private
 * @param {Object} options
 */

Outpoint.prototype.fromOptions = function fromOptions(options) {
  assert(typeof options.hash === 'string');
  assert(utils.isNumber(options.index));
  this.hash = options.hash;
  this.index = options.index;
  return this;
};

/**
 * Instantate outpoint from options object.
 * @param {Object} options
 * @returns {Outpoint}
 */

Outpoint.fromOptions = function fromOptions(options) {
  if (options instanceof Outpoint)
    return options;
  return new Outpoint().fromOptions(options);
};

/**
 * Test whether the outpoint is null (hash of zeroes
 * with max-u32 index). Used to detect coinbases.
 * @returns {Boolean}
 */

Outpoint.prototype.isNull = function isNull() {
  return this.hash === constants.NULL_HASH && this.index === 0xffffffff;
};

/**
 * Serialize outpoint.
 * @returns {Buffer}
 */

Outpoint.prototype.toRaw = function toRaw(writer) {
  var p = bcoin.writer(writer);

  p.writeHash(this.hash);
  p.writeU32(this.index);

  if (!writer)
    p = p.render();

  return p;
};

/**
 * Inject properties from serialized data.
 * @private
 * @param {Buffer} data
 */

Outpoint.prototype.fromRaw = function fromRaw(data) {
  var p = bcoin.reader(data);
  this.hash = p.readHash('hex');
  this.index = p.readU32();
  return this;
};

/**
 * Instantiate outpoint from serialized data.
 * @param {Buffer} data
 * @returns {Outpoint}
 */

Outpoint.fromRaw = function fromRaw(data) {
  return new Outpoint().fromRaw(data);
};

/**
 * Inject properties from json object.
 * @private
 * @params {Object} json
 */

Outpoint.prototype.fromJSON = function fromJSON(json) {
  assert(typeof json.hash === 'string');
  assert(utils.isNumber(json.index));
  this.hash = utils.revHex(json.hash);
  this.index = json.index;
  return this;
};

/**
 * Convert the outpoint to an object suitable
 * for JSON serialization. Note that the hash
 * will be reversed to abide by bitcoind's legacy
 * of little-endian uint256s.
 * @returns {Object}
 */

Outpoint.prototype.toJSON = function toJSON() {
  return {
    hash: utils.revHex(this.hash),
    index: this.index
  };
};

/**
 * Instantiate outpoint from json object.
 * @param {Object} json
 * @returns {Outpoint}
 */

Outpoint.fromJSON = function fromJSON(json) {
  return new Outpoint().fromJSON(json);
};

/**
 * Inject properties from tx.
 * @private
 * @param {TX} tx
 * @param {Number} index
 */

Outpoint.prototype.fromTX = function fromTX(tx, index) {
  assert(utils.isNumber(index));
  this.hash = tx.hash('hex');
  this.index = index;
  return this;
};

/**
 * Instantiate outpoint from tx.
 * @param {TX} tx
 * @param {Number} index
 * @returns {Outpoint}
 */

Outpoint.fromTX = function fromTX(tx, index) {
  return new Outpoint().fromTX(tx, index);
};

/**
 * Convert the outpoint to a user-friendly string.
 * @returns {String}
 */

Outpoint.prototype.inspect = function inspect() {
  return '<Outpoint: ' + this.hash + '/' + this.index + '>';
};

/**
 * Represents a transaction input.
 * @exports Input
 * @constructor
 * @param {NakedInput} options
 * @property {Outpoint} prevout - Outpoint.
 * @property {Script} script - Input script / scriptSig.
 * @property {Number} sequence - nSequence.
 * @property {Witness} witness - Witness (empty if not present).
 * @property {Coin?} coin - Previous output.
 */

function Input(options) {
  if (!(this instanceof Input))
    return new Input(options);

  this.prevout = new Outpoint();
  this.script = new bcoin.script();
  this.sequence = 0xffffffff;
  this.witness = new bcoin.witness();
  this.coin = null;
  this.mutable = false;
  this._address = null;

  if (options)
    this.fromOptions(options);
}

/**
 * Inject properties from options object.
 * @private
 * @param {Object} options
 */

Input.prototype.fromOptions = function fromOptions(options) {
  assert(options, 'Input data is required.');
  assert(options.prevout);

  this.prevout.fromOptions(options.prevout);

  if (options.script)
    this.script.fromOptions(options.script);

  if (options.sequence != null) {
    assert(utils.isNumber(options.sequence));
    this.sequence = options.sequence;
  }

  if (options.witness)
    this.witness.fromOptions(options.witness);

  if (options.coin)
    this.coin = bcoin.coin(options.coin);

  return this;
};

/**
 * Instantiate an Input from options object.
 * @param {NakedInput} options
 * @returns {Input}
 */

Input.fromOptions = function fromOptions(options) {
  return new Input().fromOptions(options);
};

/**
 * Get the previous output script type. Will "guess"
 * based on the input script and/or witness if coin
 * is not available.
 * @returns {String} type
 */

Input.prototype.getType = function getType() {
  var type;

  if (this.isCoinbase())
    return 'coinbase';

  if (this.coin)
    return this.coin.getType();

  if (this.witness.items.length > 0)
    type = this.witness.getInputType();
  else
    type = this.script.getInputType();

  return type;
};

/**
 * Get the redeem script. Will attempt to resolve nested
 * redeem scripts if witnessscripthash is behind a scripthash.
 * @returns {Script?} Redeem script.
 */

Input.prototype.getRedeem = function getRedeem() {
  var redeem, prev;

  if (this.isCoinbase())
    return;

  if (!this.coin) {
    if (this.witness.isScripthashInput())
      return this.witness.getRedeem();

    if (this.script.isScripthashInput())
      return this.script.getRedeem();

    return;
  }

  prev = this.coin.script;

  if (prev.isScripthash()) {
    prev = this.script.getRedeem();
    redeem = prev;
  }

  if (prev && prev.isWitnessScripthash()) {
    prev = this.witness.getRedeem();
    redeem = prev;
  }

  return redeem;
};

/**
 * Get the redeem script type.
 * @returns {String} subtype
 */

Input.prototype.getSubtype = function getSubtype() {
  var redeem;

  if (this.isCoinbase())
    return;

  redeem = this.getRedeem();

  if (!redeem)
    return;

  return redeem.getType();
};

/**
 * Get the previous output script's address. Will "guess"
 * based on the input script and/or witness if coin
 * is not available.
 * @returns {Address?} address
 */

Input.prototype.getAddress = function getAddress() {
  var address;

  if (this.isCoinbase())
    return;

  if (this.coin)
    return this.coin.getAddress();

  address = this._address;

  if (!address) {
    if (this.witness.items.length > 0)
      address = this.witness.getInputAddress();
    else
      address = this.script.getInputAddress();

    if (!this.mutable)
      this._address = address;
  }

  return address;
};

/**
 * Get the address hash.
 * @param {String?} enc
 * @returns {Hash} hash
 */

Input.prototype.getHash = function getHash(enc) {
  var address = this.getAddress();
  if (!address)
    return;
  return address.getHash(enc);
};

/**
 * Test to see if nSequence is equal to uint32max.
 * @returns {Boolean}
 */

Input.prototype.isFinal = function isFinal() {
  return this.sequence === 0xffffffff;
};

/**
 * Test to see if outpoint is null.
 * @returns {Boolean}
 */

Input.prototype.isCoinbase = function isCoinbase() {
  return this.prevout.isNull();
};

/**
 * Test the input against an address, an
 * array of addresses, or a map of hashes.
 * @param {Hash|Hash[]|AddressHashMap} addressMap
 * @returns {Boolean} Whether the input matched.
 */

Input.prototype.test = function test(addressMap) {
  var hash = this.getHash('hex');

  if (!hash)
    return false;

  if (typeof addressMap === 'string')
    return hash === addressMap;

  if (Array.isArray(addressMap))
    return addressMap.indexOf(hash) !== -1;

  if (addressMap[hash] != null)
    return true;

  return false;
};

/**
 * Convert the input to a more user-friendly object.
 * @returns {Object}
 */

Input.prototype.inspect = function inspect() {
  return {
    type: this.getType(),
    subtype: this.getSubtype(),
    address: this.getAddress(),
    script: this.script,
    witness: this.witness,
    redeem: this.getRedeem(),
    sequence: this.sequence,
    prevout: this.prevout,
    coin: this.coin
  };
};

/**
 * Convert the input to an object suitable
 * for JSON serialization. Note that the hashes
 * will be reversed to abide by bitcoind's legacy
 * of little-endian uint256s.
 * @returns {Object}
 */

Input.prototype.toJSON = function toJSON() {
  var address = this.getAddress();

  if (address)
    address = address.toBase58();

  return {
    prevout: this.prevout.toJSON(),
    coin: this.coin ? this.coin.toJSON() : null,
    script: this.script.toJSON(),
    witness: this.witness.toJSON(),
    sequence: this.sequence,
    address: address
  };
};

/**
 * Inject properties from a JSON object.
 * @private
 * @param {Object} json
 */

Input.prototype.fromJSON = function fromJSON(json) {
  assert(json, 'Input data is required.');
  assert(utils.isNumber(json.sequence));
  this.prevout.fromJSON(json.prevout);
  this.coin = json.coin ? bcoin.coin.fromJSON(json.coin) : null;
  this.script.fromJSON(json.script);
  this.witness.fromJSON(json.witness);
  this.sequence = json.sequence;
  return this;
};

/**
 * Instantiate an Input from a jsonified input object.
 * @param {Object} json - The jsonified input object.
 * @returns {Input}
 */

Input.fromJSON = function fromJSON(json) {
  return new Input().fromJSON(json);
};

/**
 * Serialize the input.
 * @param {String?} enc - Encoding, can be `'hex'` or null.
 * @returns {Buffer|String}
 */

Input.prototype.toRaw = function toRaw(writer) {
  var p = bcoin.writer(writer);

  this.prevout.toRaw(p);
  p.writeVarBytes(this.script.toRaw());
  p.writeU32(this.sequence);

  if (!writer)
    p = p.render();

  return p;
};

/**
 * Inject properties from serialized data.
 * @param {Buffer} data
 */

Input.prototype.fromRaw = function fromRaw(data) {
  var p = bcoin.reader(data);

  this.prevout.fromRaw(p);
  this.script.fromRaw(p.readVarBytes());
  this.sequence = p.readU32();

  return this;
};

/**
 * Instantiate an input from a serialized Buffer.
 * @param {Buffer} data
 * @param {String?} enc - Encoding, can be `'hex'` or null.
 * @returns {Input}
 */

Input.fromRaw = function fromRaw(data, enc) {
  if (typeof data === 'string')
    data = new Buffer(data, enc);
  return new Input().fromRaw(data);
};

/**
 * Serialize the input to an "extended" format,
 * including both the input and the witness.
 * @param {String?} enc - Encoding, can be `'hex'` or null.
 * @returns {Buffer|String}
 */

Input.prototype.toExtended = function toExtended(writer) {
  var p = bcoin.writer(writer);

  this.toRaw(p);
  this.witness.toRaw(p);

  if (!writer)
    p = p.render();

  return p;
};

/**
 * Inject properties from extended serialized data.
 * @private
 * @param {Buffer} data
 */

Input.prototype.fromExtended = function fromExtended(data) {
  var p = bcoin.reader(data);
  this.fromRaw(p);
  this.witness.fromRaw(p);
  return this;
};

/**
 * Instantiate an input from a Buffer
 * in "extended" serialization format.
 * @param {Buffer} data
 * @param {String?} enc - Encoding, can be `'hex'` or null.
 * @returns {TX}
 */

Input.fromExtended = function fromExtended(data, enc) {
  if (typeof data === 'string')
    data = new Buffer(data, enc);
  return new Input().fromExtended(data);
};

/**
 * Inject properties from coin.
 * @private
 * @param {Coin} coin
 */

Input.prototype.fromCoin = function fromCoin(coin) {
  assert(typeof coin.hash === 'string');
  assert(typeof coin.index === 'number');
  this.prevout.hash = coin.hash;
  this.prevout.index = coin.index;
  this.coin = coin;
  return this;
};

/**
 * Instantiate input from coin.
 * @param {Coin}
 * @returns {Input}
 */

Input.fromCoin = function fromCoin(coin) {
  return new Input().fromCoin(coin);
};

/**
 * Inject properties from transaction.
 * @private
 * @param {TX} tx
 * @param {Number} index
 */

Input.prototype.fromTX = function fromTX(tx, index) {
  var coin = bcoin.coin.fromTX(tx, index);
  return this.fromCoin(coin);
};

/**
 * Instantiate input from tx.
 * @param {TX} tx
 * @param {Number} index
 * @returns {Input}
 */

Input.fromTX = function fromTX(tx, index) {
  return new Input().fromTX(tx, index);
};

/**
 * Test an object to see if it is an Input.
 * @param {Object} obj
 * @returns {Boolean}
 */

Input.isInput = function isInput(obj) {
  return obj
    && obj.prevout !== undefined
    && obj.script !== undefined
    && obj.witness !== undefined
    && typeof obj.getAddress === 'function';
};

/*
 * Expose
 */

exports = Input;
exports.Outpoint = Outpoint;
module.exports = exports;
