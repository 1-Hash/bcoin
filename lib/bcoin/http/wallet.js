/*!
 * wallet.js - http wallet for bcoin
 * Copyright (c) 2014-2015, Fedor Indutny (MIT License)
 * Copyright (c) 2014-2016, Christopher Jeffrey (MIT License).
 * https://github.com/bcoin-org/bcoin
 */

'use strict';

var Network = require('../network');
var EventEmitter = require('events').EventEmitter;

var utils = require('../utils');
var http = require('./');

/**
 * HTTPWallet
 * @exports HTTPWallet
 * @constructor
 * @param {String} uri
 */

function HTTPWallet(options) {
  if (!(this instanceof HTTPWallet))
    return new HTTPWallet(options);

  EventEmitter.call(this);

  if (!options)
    options = {};

  if (typeof options === 'string')
    options = { uri: options };

  this.options = options;
  this.network = Network.get(options.network);

  this.client = new http.client(options);
  this.uri = options.uri;
  this.id = null;
  this.token = null;

  this._init();
}

utils.inherits(HTTPWallet, EventEmitter);

/**
 * Initialize the wallet.
 * @private
 */

HTTPWallet.prototype._init = function _init() {
  var self = this;

  this.client.on('tx', function(details) {
    self.emit('tx', details);
  });

  this.client.on('confirmed', function(details) {
    self.emit('confirmed', details);
  });

  this.client.on('unconfirmed', function(tx, details) {
    self.emit('unconfirmed', details);
  });

  this.client.on('conflict', function(tx, details) {
    self.emit('conflict', details);
  });

  this.client.on('balance', function(balance) {
    self.emit('balance', balance);
  });

  this.client.on('address', function(receive) {
    self.emit('address', receive);
  });

  this.client.on('error', function(err) {
    self.emit('error', err);
  });
};

/**
 * Open the client and get a wallet.
 * @alias HTTPWallet#open
 * @param {Function} callback
 */

HTTPWallet.prototype.open = function open(options, callback) {
  var self = this;

  this.id = options.id;

  if (options.token) {
    this.token = options.token;
    if (Buffer.isBuffer(this.token))
      this.token = this.token.toString('hex');
    this.client.token = this.token;
  }

  this.client.open(function(err) {
    if (err)
      return callback(err);

    self.client.getWallet(self.id, function(err, wallet) {
      if (err)
        return callback(err);
      self.client.join(self.id, wallet.token, function(err) {
        if (err)
          return callback(new Error(err.error));
        callback(null, wallet);
      });
    });
  });
};

/**
 * Open the client and create a wallet.
 * @alias HTTPWallet#open
 * @param {Function} callback
 */

HTTPWallet.prototype.create = function create(options, callback) {
  var self = this;

  this.client.open(function(err) {
    if (err)
      return callback(err);

    self.client.createWallet(options, function(err, wallet) {
      if (err)
        return callback(err);

      self.open({
        id: wallet.id,
        token: wallet.token
      }, callback);
    });
  });
};

/**
 * Close the client, wait for the socket to close.
 * @alias HTTPWallet#close
 * @param {Function} callback
 */

HTTPWallet.prototype.close = function close(callback) {
  this.client.close(callback);
};

/**
 * @see Wallet#getHistory
 */

HTTPWallet.prototype.getHistory = function getHistory(account, callback) {
  this.client.getHistory(this.id, account, callback);
};

/**
 * @see Wallet#getCoins
 */

HTTPWallet.prototype.getCoins = function getCoins(account, callback) {
  this.client.getCoins(this.id, account, callback);
};

/**
 * @see Wallet#getUnconfirmed
 */

HTTPWallet.prototype.getUnconfirmed = function getUnconfirmed(account, callback) {
  this.client.getUnconfirmed(this.id, account, callback);
};

/**
 * @see Wallet#getBalance
 */

HTTPWallet.prototype.getBalance = function getBalance(account, callback) {
  this.client.getBalance(this.id, account, callback);
};

/**
 * @see Wallet#getLast
 */

HTTPWallet.prototype.getLast = function getLast(account, limit, callback) {
  this.client.getLast(this.id, account, limit, callback);
};

/**
 * @see Wallet#getRange
 */

HTTPWallet.prototype.getRange = function getRange(account, options, callback) {
  this.client.getRange(this.id, account, options, callback);
};

/**
 * @see Wallet#getTX
 */

HTTPWallet.prototype.getTX = function getTX(account, hash, callback) {
  this.client.getWalletTX(this.id, account, hash, callback);
};

/**
 * @see Wallet#getCoin
 */

HTTPWallet.prototype.getCoin = function getCoin(account, hash, index, callback) {
  this.client.getWalletCoin(this.id, account, hash, index, callback);
};

/**
 * @see Wallet#zap
 */

HTTPWallet.prototype.zap = function zap(account, age, callback) {
  this.client.zap(this.id, account, age, callback);
};

/**
 * @see Wallet#createTX
 */

HTTPWallet.prototype.createTX = function createTX(options, outputs, callback) {
  this.client.createTX(this.id, options, outputs, callback);
};

/**
 * @see HTTPClient#walletSend
 */

HTTPWallet.prototype.send = function send(options, callback) {
  this.client.send(this.id, options, callback);
};

/**
 * @see Wallet#sign
 */

HTTPWallet.prototype.sign = function sign(tx, options, callback) {
  this.client.sign(this.id, tx, options, callback);
};

/**
 * @see Wallet#fillCoins
 */

HTTPWallet.prototype.fillCoins = function fillCoins(tx, callback) {
  this.client.fillCoins(tx, callback);
};

/**
 * @see HTTPClient#getWallet
 */

HTTPWallet.prototype.getInfo = function getInfo(callback) {
  this.client.getWallet(this.id, callback);
};

/**
 * @see Wallet#getAccounts
 */

HTTPWallet.prototype.getAccounts = function getAccounts(callback) {
  this.client.getAccounts(this.id, callback);
};

/**
 * @see Wallet#getAccount
 */

HTTPWallet.prototype.getAccount = function getAccount(account, callback) {
  this.client.getAccount(this.id, account, callback);
};

/**
 * @see Wallet#createAccount
 */

HTTPWallet.prototype.createAccount = function createAccount(options, callback) {
  this.client.createAccount(this.id, options, callback);
};

/**
 * @see Wallet#setPassphrase
 */

HTTPWallet.prototype.setPassphrase = function setPassphrase(old, new_, callback) {
  this.client.setPassphrase(this.id, old, new_, callback);
};

/**
 * @see Wallet#retoken
 */

HTTPWallet.prototype.retoken = function retoken(passphrase, callback) {
  var self = this;
  this.client.retoken(this.id, passphrase, function(err, token) {
    if (err)
      return callback(err);

    self.token = token;
    self.client.token = token;

    return callback(null, token);
  });
};

/*
 * Expose
 */

module.exports = HTTPWallet;
