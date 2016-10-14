/*!
 * chainentry.js - chainentry object for bcoin
 * Copyright (c) 2014-2015, Fedor Indutny (MIT License)
 * Copyright (c) 2014-2016, Christopher Jeffrey (MIT License).
 * https://github.com/bcoin-org/bcoin
 */

'use strict';

var BN = require('bn.js');
var Network = require('../protocol/network');
var constants = require('../protocol/constants');
var utils = require('../utils/utils');
var crypto = require('../crypto/crypto');
var assert = require('assert');
var BufferWriter = require('../utils/writer');
var BufferReader = require('../utils/reader');
var Headers = require('../primitives/headers');
var InvItem = require('../primitives/invitem');
var co = require('../utils/co');

/**
 * Represents an entry in the chain. Unlike
 * other bitcoin fullnodes, we store the
 * chainwork _with_ the entry in order to
 * avoid reading the entire chain index on
 * boot and recalculating the chainworks.
 * @exports ChainEntry
 * @constructor
 * @param {Chain} chain
 * @param {Object} options
 * @param {ChainEntry} prev
 * @property {Hash} hash
 * @property {Number} version - Transaction version. Note that BCoin reads
 * versions as unsigned even though they are signed at the protocol level.
 * This value will never be negative.
 * @property {Hash} prevBlock
 * @property {Hash} merkleRoot
 * @property {Number} ts
 * @property {Number} bits
 * @property {Number} nonce
 * @property {Number} height
 * @property {BN} chainwork
 * @property {ReversedHash} rhash - Reversed block hash (uint256le).
 */

function ChainEntry(chain, options, prev) {
  if (!(this instanceof ChainEntry))
    return new ChainEntry(chain, options, prev);

  this.chain = chain;
  this.network = chain ? chain.network : Network.primary;

  this.hash = constants.NULL_HASH;
  this.version = 1;
  this.prevBlock = constants.NULL_HASH;
  this.merkleRoot = constants.NULL_HASH;
  this.ts = 0;
  this.bits = 0;
  this.nonce = 0;
  this.height = -1;
  this.chainwork = null;

  if (options)
    this.fromOptions(options, prev);
}

/**
 * Inject properties from options.
 * @private
 * @param {Object} options
 * @param {ChainEntry} prev - Previous entry.
 */

ChainEntry.prototype.fromOptions = function fromOptions(options, prev) {
  assert(options, 'Block data is required.');
  assert(typeof options.hash === 'string');
  assert(utils.isNumber(options.version));
  assert(typeof options.prevBlock === 'string');
  assert(typeof options.merkleRoot === 'string');
  assert(utils.isNumber(options.ts));
  assert(utils.isNumber(options.bits));
  assert(utils.isNumber(options.nonce));
  assert(!options.chainwork || BN.isBN(options.chainwork));

  this.hash = options.hash;
  this.version = options.version;
  this.prevBlock = options.prevBlock;
  this.merkleRoot = options.merkleRoot;
  this.ts = options.ts;
  this.bits = options.bits;
  this.nonce = options.nonce;
  this.height = options.height;
  this.chainwork = options.chainwork;

  if (!this.chainwork)
    this.chainwork = this.getChainwork(prev);

  return this;
};

/**
 * Instantiate chainentry from options.
 * @param {Chain} chain
 * @param {Object} options
 * @param {ChainEntry} prev - Previous entry.
 * @returns {ChainEntry}
 */

ChainEntry.fromOptions = function fromOptions(chain, options, prev) {
  return new ChainEntry(chain).fromOptions(options, prev);
};

/**
 * The max chainwork (1 << 256).
 * @const {BN}
 */

ChainEntry.MAX_CHAINWORK = new BN(1).ushln(256);

/**
 * Calculate the proof: (1 << 256) / (target + 1)
 * @returns {BN} proof
 */

ChainEntry.prototype.getProof = function getProof() {
  var target = utils.fromCompact(this.bits);
  if (target.isNeg() || target.cmpn(0) === 0)
    return new BN(0);
  return ChainEntry.MAX_CHAINWORK.div(target.iaddn(1));
};

/**
 * Calculate the chainwork by
 * adding proof to previous chainwork.
 * @returns {BN} chainwork
 */

ChainEntry.prototype.getChainwork = function getChainwork(prev) {
  var proof = this.getProof();

  if (!prev)
    return proof;

  return proof.iadd(prev.chainwork);
};

/**
 * Test against the genesis block.
 * @returns {Boolean}
 */

ChainEntry.prototype.isGenesis = function isGenesis() {
  return this.hash === this.network.genesis.hash;
};

/**
 * Allocate ancestors based on retarget interval and
 * majority window. These ancestors will be stored
 * in the `ancestors` array and enable use of synchronous
 * ChainEntry methods.
 * @returns {Promise}
 */

ChainEntry.prototype.getRetargetAncestors = function getRetargetAncestors() {
  var majorityWindow = this.network.block.majorityWindow;
  var medianTimespan = constants.block.MEDIAN_TIMESPAN;
  var powDiffInterval = this.network.pow.retargetInterval;
  var diffReset = this.network.pow.difficultyReset;
  var max = Math.max(majorityWindow, medianTimespan);
  if ((this.height + 1) % powDiffInterval === 0 || diffReset)
    max = Math.max(max, powDiffInterval);
  return this.getAncestors(max);
};

/**
 * Collect ancestors.
 * @param {Number} max - Number of ancestors.
 * @returns {Promise} - Returns ChainEntry[].
 */

ChainEntry.prototype.getAncestors = co(function* getAncestors(max) {
  var entry = this;
  var ancestors = [];
  var cached;

  if (max === 0)
    return ancestors;

  assert(utils.isNumber(max));

  // Try to do this iteratively and synchronously
  // so we don't have to wait on nextTicks.
  for (;;) {
    ancestors.push(entry);

    if (ancestors.length >= max)
      return ancestors;

    cached = this.chain.db.getCache(entry.prevBlock);

    if (!cached) {
      ancestors.pop();
      break;
    }

    entry = cached;
  }

  while (entry) {
    ancestors.push(entry);
    if (ancestors.length >= max)
      break;
    entry = yield entry.getPrevious();
  }

  return ancestors;
});

/**
 * Test whether the entry is in the main chain.
 * @returns {Promise} - Return Boolean.
 */

ChainEntry.prototype.isMainChain = function isMainChain() {
  return this.chain.db.isMainChain(this);
};

/**
 * Collect ancestors up to `height`.
 * @param {Number} height
 * @returns {Promise} - Returns ChainEntry[].
 */

ChainEntry.prototype.getAncestorByHeight = co(function* getAncestorByHeight(height) {
  var main, entry;

  if (height < 0)
    return yield co.wait();

  assert(height >= 0);
  assert(height <= this.height);

  main = yield this.isMainChain();

  if (main)
    return yield this.chain.db.get(height);

  entry = yield this.getAncestor(this.height - height);

  if (!entry)
    return;

  assert(entry.height === height);

  return entry;
});

/**
 * Get a single ancestor by index. Note that index-0 is
 * the same entry. This is done for sane porting of
 * bitcoind functions to BCoin.
 * @param {Number} index
 * @returns {Function} callback - Returns [Error, ChainEntry].
 */

ChainEntry.prototype.getAncestor = co(function* getAncestor(index) {
  var ancestors;

  assert(index >= 0);

  ancestors = yield this.getAncestors(index + 1);

  if (ancestors.length < index + 1)
    return;

  return ancestors[index];
});

/**
 * Get previous entry.
 * @returns {Promise} - Returns ChainEntry.
 */

ChainEntry.prototype.getPrevious = function getPrevious() {
  return this.chain.db.get(this.prevBlock);
};

/**
 * Get next entry.
 * @returns {Promise} - Returns ChainEntry.
 */

ChainEntry.prototype.getNext = co(function* getNext() {
  var hash = yield this.chain.db.getNextHash(this.hash);
  if (!hash)
    return;
  return yield this.chain.db.get(hash);
});

/**
 * Get median time past.
 * @see GetMedianTimePast().
 * @param {ChainEntry[]} ancestors - Note that index 0 is the same entry.
 * @returns {Number} Median time past.
 */

ChainEntry.prototype.getMedianTime = function getMedianTime(ancestors) {
  var entry = this;
  var median = [];
  var timeSpan = constants.block.MEDIAN_TIMESPAN;
  var i;

  for (i = 0; i < timeSpan && entry; i++, entry = ancestors[i])
    median.push(entry.ts);

  median = median.sort();

  return median[median.length / 2 | 0];
};

/**
 * Get median time past asynchronously (see {@link ChainEntry#getMedianTime}).
 * @returns {Promise} - Returns Number.
 */

ChainEntry.prototype.getMedianTimeAsync = co(function* getMedianTimeAsync() {
  var MEDIAN_TIMESPAN = constants.block.MEDIAN_TIMESPAN;
  var ancestors = yield this.getAncestors(MEDIAN_TIMESPAN);
  return this.getMedianTime(ancestors);
});

/**
 * Check isSuperMajority against majorityRejectOutdated.
 * @param {Number} version
 * @param {ChainEntry[]} ancestors
 * @returns {Boolean}
 */

ChainEntry.prototype.isOutdated = function isOutdated(version, ancestors) {
  return this.isSuperMajority(version,
    this.network.block.majorityRejectOutdated,
    ancestors);
};

/**
 * Check {@link ChainEntry#isUpgraded asynchronously}.
 * @param {Number} version
 * @returns {Promise} - Returns Boolean.
 * @returns {Boolean}
 */

ChainEntry.prototype.isOutdatedAsync = function isOutdatedAsync(version) {
  return this.isSuperMajorityAsync(version,
    this.network.block.majorityRejectOutdated);
};

/**
 * Check isSuperMajority against majorityEnforceUpgrade.
 * @param {Number} version
 * @param {ChainEntry[]} ancestors
 * @returns {Boolean}
 */

ChainEntry.prototype.isUpgraded = function isUpgraded(version, ancestors) {
  return this.isSuperMajority(version,
    this.network.block.majorityEnforceUpgrade,
    ancestors);
};

/**
 * Check {@link ChainEntry#isUpgraded} asynchronously.
 * @param {Number} version
 * @returns {Promise}
 * @returns {Boolean}
 */

ChainEntry.prototype.isUpgradedAsync = function isUpgradedAsync(version) {
  return this.isSuperMajorityAsync(version,
    this.network.block.majorityEnforceUpgrade);
};

/**
 * Calculate found number of block versions within the majority window.
 * @param {Number} version
 * @param {Number} required
 * @param {ChainEntry[]} ancestors
 * @returns {Boolean}
 */

ChainEntry.prototype.isSuperMajority = function isSuperMajority(version, required, ancestors) {
  var entry = this;
  var found = 0;
  var majorityWindow = this.network.block.majorityWindow;
  var i;

  for (i = 0; i < majorityWindow && found < required && entry; i++) {
    if (entry.version >= version)
      found++;
    entry = ancestors[i + 1];
  }

  return found >= required;
};

/**
 * Calculate {@link ChainEntry#isSuperMajority asynchronously}.
 * @param {Number} version
 * @param {Number} required
 * @returns {Promise} - Returns Boolean.
 * @returns {Boolean}
 */

ChainEntry.prototype.isSuperMajorityAsync = co(function* isSuperMajorityAsync(version, required) {
  var majorityWindow = this.network.block.majorityWindow;
  var ancestors = yield this.getAncestors(majorityWindow);
  return this.isSuperMajority(version, required, ancestors);
});

/**
 * Test whether the entry is potentially
 * an ancestor of a checkpoint.
 * @returns {Boolean}
 */

ChainEntry.prototype.isHistorical = function isHistorical() {
  if (this.chain.options.useCheckpoints) {
    if (this.height + 1 <= this.network.checkpoints.lastHeight)
      return true;
  }
  return false;
};

/**
 * Test whether the entry contains a version bit.
 * @param {Object} deployment
 * @returns {Boolean}
 */

ChainEntry.prototype.hasBit = function hasBit(deployment) {
  var bits = this.version & constants.versionbits.TOP_MASK;
  var topBits = constants.versionbits.TOP_BITS;
  var mask = 1 << deployment.bit;
  return bits === topBits && (this.version & mask) !== 0;
};

ChainEntry.prototype.__defineGetter__('rhash', function() {
  return utils.revHex(this.hash);
});

/**
 * Inject properties from block.
 * @private
 * @param {Block|MerkleBlock} block
 * @param {ChainEntry} prev - Previous entry.
 */

ChainEntry.prototype.fromBlock = function fromBlock(block, prev) {
  assert(block.height !== -1);

  this.hash = block.hash('hex');
  this.version = block.version;
  this.prevBlock = block.prevBlock;
  this.merkleRoot = block.merkleRoot;
  this.ts = block.ts;
  this.bits = block.bits;
  this.nonce = block.nonce;
  this.height = block.height;
  this.chainwork = this.getChainwork(prev);

  return this;
};

/**
 * Instantiate chainentry from block.
 * @param {Chain} chain
 * @param {Block|MerkleBlock} block
 * @param {ChainEntry} prev - Previous entry.
 * @returns {ChainEntry}
 */

ChainEntry.fromBlock = function fromBlock(chain, block, prev) {
  return new ChainEntry(chain).fromBlock(block, prev);
};

/**
 * Serialize the entry to internal database format.
 * @returns {Buffer}
 */

ChainEntry.prototype.toRaw = function toRaw(writer) {
  var p = new BufferWriter(writer);

  p.writeU32(this.version);
  p.writeHash(this.prevBlock);
  p.writeHash(this.merkleRoot);
  p.writeU32(this.ts);
  p.writeU32(this.bits);
  p.writeU32(this.nonce);
  p.writeU32(this.height);
  p.writeBytes(this.chainwork.toArrayLike(Buffer, 'le', 32));

  if (!writer)
    p = p.render();

  return p;
};

/**
 * Inject properties from serialized data.
 * @private
 * @param {Buffer} data
 */

ChainEntry.prototype.fromRaw = function fromRaw(data) {
  var p = new BufferReader(data, true);
  var hash = crypto.hash256(p.readBytes(80));

  p.seek(-80);

  this.hash = hash.toString('hex');
  this.version = p.readU32(); // Technically signed
  this.prevBlock = p.readHash('hex');
  this.merkleRoot = p.readHash('hex');
  this.ts = p.readU32();
  this.bits = p.readU32();
  this.nonce = p.readU32();
  this.height = p.readU32();
  this.chainwork = new BN(p.readBytes(32), 'le');

  return this;
};

/**
 * Deserialize the entry.
 * @param {Chain} chain
 * @param {Buffer} data
 * @returns {ChainEntry}
 */

ChainEntry.fromRaw = function fromRaw(chain, data) {
  return new ChainEntry(chain).fromRaw(data);
};

/**
 * Serialize the entry to an object more
 * suitable for JSON serialization.
 * @returns {Object}
 */

ChainEntry.prototype.toJSON = function toJSON() {
  return {
    hash: utils.revHex(this.hash),
    version: this.version,
    prevBlock: utils.revHex(this.prevBlock),
    merkleRoot: utils.revHex(this.merkleRoot),
    ts: this.ts,
    bits: this.bits,
    nonce: this.nonce,
    height: this.height,
    chainwork: this.chainwork.toString(10)
  };
};

/**
 * Inject properties from json object.
 * @private
 * @param {Object} json
 */

ChainEntry.prototype.fromJSON = function fromJSON(json) {
  assert(json, 'Block data is required.');
  assert(typeof json.hash === 'string');
  assert(utils.isNumber(json.version));
  assert(typeof json.prevBlock === 'string');
  assert(typeof json.merkleRoot === 'string');
  assert(utils.isNumber(json.ts));
  assert(utils.isNumber(json.bits));
  assert(utils.isNumber(json.nonce));
  assert(typeof json.chainwork === 'string');

  this.hash = utils.revHex(json.hash);
  this.version = json.version;
  this.prevBlock = utils.revHex(json.prevBlock);
  this.merkleRoot = utils.revHex(json.merkleRoot);
  this.ts = json.ts;
  this.bits = json.bits;
  this.nonce = json.nonce;
  this.height = json.height;
  this.chainwork = new BN(json.chainwork, 10);

  return this;
};

/**
 * Instantiate block from jsonified object.
 * @param {Chain} chain
 * @param {Object} json
 * @returns {ChainEntry}
 */

ChainEntry.fromJSON = function fromJSON(chain, json) {
  return new ChainEntry(chain).fromJSON(json);
};

/**
 * Convert the entry to a headers object.
 * @returns {Headers}
 */

ChainEntry.prototype.toHeaders = function toHeaders() {
  return Headers.fromEntry(this);
};

/**
 * Convert the entry to an inv item.
 * @returns {InvItem}
 */

ChainEntry.prototype.toInv = function toInv() {
  return new InvItem(constants.inv.BLOCK, this.hash);
};

/**
 * Return a more user-friendly object.
 * @returns {Object}
 */

ChainEntry.prototype.inspect = function inspect() {
  return this.toJSON();
};

/**
 * Test whether an object is a {@link ChainEntry}.
 * @param {Object} obj
 * @returns {Boolean}
 */

ChainEntry.isChainEntry = function isChainEntry(obj) {
  return obj
    && obj.chainwork !== undefined
    && typeof obj.getMedianTime === 'function';
};

/*
 * Expose
 */

module.exports = ChainEntry;
