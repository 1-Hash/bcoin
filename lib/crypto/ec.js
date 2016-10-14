/*!
 * ec.js - ecdsa wrapper for secp256k1 and elliptic
 * Copyright (c) 2014-2015, Fedor Indutny (MIT License)
 * Copyright (c) 2014-2016, Christopher Jeffrey (MIT License).
 * https://github.com/bcoin-org/bcoin
 */

'use strict';

var elliptic = require('elliptic');
var BN = require('bn.js');
var utils = require('../utils/utils');
var crypto = require('./crypto');
var assert = require('assert');
var secp256k1;

try {
  if (+process.env.BCOIN_USE_ELLIPTIC !== 1)
    secp256k1 = require('secp256k1');
} catch (e) {
  ;
}

/*
 * Constants
 */

var ZERO_S = new Buffer(
  '0000000000000000000000000000000000000000000000000000000000000000',
  'hex'
);

var HALF_ORDER = new Buffer(
  '7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0',
  'hex');

/**
 * @exports ec
 */

var ec = exports;

/**
 * elliptic.js secp256k1 curve.
 * @type {Object}
 */

ec.elliptic = elliptic.ec('secp256k1');

/**
 * elliptic.js signature constructor.
 * @static
 * @type {Function}
 */

ec.signature = require('elliptic/lib/elliptic/ec/signature');

/**
 * elliptic.js keypair constructor.
 * @static
 * @type {Function}
 */

ec.keypair = require('elliptic/lib/elliptic/ec/key');

/**
 * A reference to the secp256k1 curve.
 * @const {Object}
 */

ec.curve = ec.elliptic.curve;

/**
 * Generate a private key.
 * @returns {Buffer} Private key.
 */

ec.generatePrivateKey = function generatePrivateKey() {
  var key, priv;

  if (secp256k1) {
    do {
      priv = crypto.randomBytes(32);
    } while (!secp256k1.privateKeyVerify(priv));
  } else {
    key = ec.elliptic.genKeyPair();
    priv = key.getPrivate().toArrayLike(Buffer, 'be', 32);
  }

  return priv;
};

/**
 * Create a public key from a private key.
 * @param {Buffer} priv
 * @param {Boolean?} compressed
 * @returns {Buffer}
 */

ec.publicKeyCreate = function publicKeyCreate(priv, compressed) {
  assert(Buffer.isBuffer(priv));

  if (secp256k1)
    return secp256k1.publicKeyCreate(priv, compressed);

  priv = ec.elliptic.keyPair({ priv: priv });
  priv = priv.getPublic(compressed !== false, 'array');

  return new Buffer(priv);
};

/**
 * Compress or decompress public key.
 * @param {Buffer} pub
 * @returns {Buffer}
 */

ec.publicKeyConvert = function publicKeyConvert(key, compressed) {
  var point;

  if (secp256k1)
    return secp256k1.publicKeyConvert(key, compressed);

  point = ec.curve.decodePoint(key);

  return new Buffer(point.encode('array', compressed !== false));
};

/**
 * ((tweak + key) % n)
 * @param {Buffer} privateKey
 * @param {Buffer} tweak
 * @returns {Buffer} privateKey
 */

ec.privateKeyTweakAdd = function privateKeyTweakAdd(privateKey, tweak) {
  var key;

  if (secp256k1)
    return secp256k1.privateKeyTweakAdd(privateKey, tweak);

  key = new BN(tweak)
    .add(new BN(privateKey))
    .mod(ec.curve.n)
    .toArrayLike(Buffer, 'be', 32);

  // Only a 1 in 2^127 chance of happening.
  if (!ec.privateKeyVerify(key))
    throw new Error('Private key is invalid.');

  return key;
};

/**
 * ((g * tweak) + key)
 * @param {Buffer} publicKey
 * @param {Buffer} tweak
 * @returns {Buffer} publicKey
 */

ec.publicKeyTweakAdd = function publicKeyTweakAdd(publicKey, tweak, compressed) {
  var point, key;

  if (secp256k1)
    return secp256k1.publicKeyTweakAdd(publicKey, tweak, compressed);

  point = ec.curve.decodePoint(publicKey);
  point = ec.curve.g.mul(new BN(tweak)).add(point);
  key = new Buffer(point.encode('array', compressed !== false));

  if (!ec.publicKeyVerify(key))
    throw new Error('Public key is invalid.');

  return key;
};

/**
 * Create an ecdh.
 * @param {Buffer} pub
 * @param {Buffer} priv
 * @returns {Buffer}
 */

ec.ecdh = function ecdh(pub, priv) {
  var point;

  if (secp256k1) {
    point = secp256k1.ecdhUnsafe(pub, priv, true);
    return point.slice(1, 33);
  }

  priv = ec.elliptic.keyPair({ priv: priv });
  pub = ec.elliptic.keyPair({ pub: pub });

  return priv.derive(pub.getPublic()).toArrayLike(Buffer, 'be', 32);
};

/**
 * Recover a public key.
 * @param {Buffer} msg
 * @param {Buffer} sig
 * @param {Number?} j
 * @param {Boolean?} compressed
 * @returns {Buffer[]|Buffer|null}
 */

ec.recover = function recover(msg, sig, j, compressed) {
  var point, key;

  if (!j)
    j = 0;

  if (secp256k1) {
    try {
      sig = secp256k1.signatureImport(sig);
    } catch (e) {
      return;
    }

    try {
      key = secp256k1.recover(msg, sig, j, compressed);
    } catch (e) {
      return;
    }

    return key;
  }

  try {
    point = ec.elliptic.recoverPubKey(msg, sig, j);
  } catch (e) {
    return;
  }

  key = point.encode('array', compressed !== false);

  return new Buffer(key);
};

/**
 * Verify a signature.
 * @param {Buffer} msg
 * @param {Buffer} sig - DER formatted.
 * @param {Buffer} key
 * @param {Boolean?} - Whether this should be treated as a
 * "historical" signature. This allows signatures to be of
 * odd lengths.
 * @param {Boolean?} high - Allow high S value.
 * @returns {Boolean}
 */

ec.verify = function verify(msg, sig, key, historical, high) {
  var result;

  assert(Buffer.isBuffer(msg));
  assert(Buffer.isBuffer(sig));
  assert(Buffer.isBuffer(key));

  if (sig.length === 0)
    return false;

  if (key.length === 0)
    return false;

  if (secp256k1) {
    try {
      if (historical)
        sig = secp256k1.signatureImportLax(sig);
      else
        sig = secp256k1.signatureImport(sig);

      if (high)
        sig = secp256k1.signatureNormalize(sig);

      result = secp256k1.verify(msg, sig, key);
    } catch (e) {
      result = false;
    }

    return result;
  }

  // Attempt to normalize the signature
  // length before passing to elliptic.
  // Note: We only do this for historical data!
  // https://github.com/indutny/elliptic/issues/78
  if (historical)
    sig = ec.normalizeLength(sig);

  // Make elliptic mimic secp256k1's
  // failure with high S values.
  if (!high && !ec.isLowS(sig))
    return false;

  try {
    result = ec.elliptic.verify(msg, sig, key);
  } catch (e) {
    result = false;
  }

  return result;
};

/**
 * Validate a public key.
 * @param {Buffer} key
 * @returns {Boolean} True if buffer is a valid public key.
 */

ec.publicKeyVerify = function publicKeyVerify(key) {
  var result;

  if (secp256k1)
    return secp256k1.publicKeyVerify(key);

  try {
    result = ec.elliptic.keyPair({ pub: key }).validate();
  } catch (e) {
    result = false;
  }

  return result;
};

/**
 * Validate a private key.
 * @param {Buffer} key
 * @returns {Boolean} True if buffer is a valid private key.
 */

ec.privateKeyVerify = function privateKeyVerify(key) {
  if (secp256k1)
    return secp256k1.privateKeyVerify(key);

  if (key.length !== 32)
    return false;

  key = new BN(key);

  return key.cmpn(0) !== 0 && key.cmp(ec.curve.n) < 0;
};

/**
 * Sign a message.
 * @param {Buffer} msg
 * @param {Buffer} key - Private key.
 * @returns {Buffer} DER-formatted signature.
 */

ec.sign = function sign(msg, key) {
  var sig;

  assert(Buffer.isBuffer(msg));
  assert(Buffer.isBuffer(key));

  if (secp256k1) {
    // Sign message
    sig = secp256k1.sign(msg, key);

    // Ensure low S value
    sig = secp256k1.signatureNormalize(sig.signature);

    // Convert to DER array
    sig = secp256k1.signatureExport(sig);
  } else {
    // Sign message and ensure low S value
    sig = ec.elliptic.sign(msg, key, { canonical: true });

    // Convert to DER array
    sig = new Buffer(sig.toDER());
  }

  return sig;
};

/**
 * Convert DER signature to R/S.
 * @param {Buffer} sig
 * @returns {Buffer} R/S-formatted signature.
 */

ec.fromDER = function fromDER(sig) {
  var out;

  assert(Buffer.isBuffer(sig));

  if (secp256k1)
    return secp256k1.signatureImport(sig);

  sig = new ec.signature(sig);
  out = new Buffer(64);

  sig.r.toArrayLike(Buffer, 'be', 32).copy(out, 0);
  sig.s.toArrayLike(Buffer, 'be', 32).copy(out, 32);

  return out;
};

/**
 * Convert R/S signature to DER.
 * @param {Buffer} sig
 * @returns {Buffer} DER-formatted signature.
 */

ec.toDER = function toDER(sig) {
  var out;

  assert(Buffer.isBuffer(sig));

  if (secp256k1)
    return secp256k1.signatureExport(sig);

  out = new ec.signature({
    r: new BN(sig.slice(0, 32), 'be'),
    s: new BN(sig.slice(32, 64), 'be')
  });

  return new Buffer(out.toDER());
};

/**
 * Normalize the length of a signature
 * (only done for historical data).
 * @param {Buffer} sig - DER formatted signature.
 * @returns {Buffer} Signature.
 */

ec.normalizeLength = function normalizeLength(sig) {
  var data = sig;
  var p = { place: 0 };
  var len, rlen, slen;

  if (data[p.place++] !== 0x30)
    return sig;

  len = getLength(data, p);

  if (data.length > len + p.place)
    data = data.slice(0, len + p.place);

  if (data[p.place++] !== 0x02)
    return sig;

  rlen = getLength(data, p);
  p.place += rlen;

  if (data[p.place++] !== 0x02)
    return sig;

  slen = getLength(data, p);
  if (data.length > slen + p.place)
    data = data.slice(0, slen + p.place);

  return data;
};

/**
 * Test whether a signature has a low S value.
 * @param {Buffer} sig
 * @returns {Boolean}
 */

ec.isLowS = function isLowS(sig) {
  var rs, s;

  if (secp256k1) {
    try {
      rs = secp256k1.signatureImport(sig);
      s = rs.slice(32, 64);
    } catch (e) {
      return false;
    }

    if (utils.equal(s, ZERO_S))
      return false;

    // If S is greater than half the order,
    // it's too high.
    if (utils.cmp(s, HALF_ORDER) > 0)
      return false;

    return true;
  }

  try {
    sig = new ec.signature(sig);
  } catch (e) {
    return false;
  }

  if (sig.s.cmpn(0) === 0)
    return false;

  // If S is greater than half the order,
  // it's too high.
  if (sig.s.cmp(ec.elliptic.nh) > 0)
    return false;

  return true;
};

/*
 * Helpers
 */

function getLength(buf, p) {
  var initial = buf[p.place++];
  var octetLen, val, i, off;

  if (!(initial & 0x80))
    return initial;

  octetLen = initial & 0xf;
  val = 0;

  for (i = 0, off = p.place; i < octetLen; i++, off++) {
    val <<= 8;
    val |= buf[off];
  }

  p.place = off;

  return val;
}
