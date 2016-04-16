var bn = require('bn.js');
delete process.env.BCOIN_NETWORK;
var bcoin = require('../')({ network: 'regtest', db: 'memory' });
process.env.BCOIN_NETWORK = 'main';
var constants = bcoin.protocol.constants;
var utils = bcoin.utils;
var assert = utils.assert;
var opcodes = constants.opcodes;

constants.tx.coinbaseMaturity = 0;

describe('Chain', function() {
  var chain, wallet, miner;
  var competingTip, oldTip, ch1, ch2, cb1, cb2;

  chain = new bcoin.chain();
  wallet = new bcoin.wallet();
  miner = new bcoin.miner({
    chain: chain,
    address: wallet.getAddress()
  });

  chain.on('error', function() {});
  miner.on('error', function() {});

  function mineBlock(entry, tx, callback) {
    var realTip;
    if (entry) {
      realTip = chain.tip;
      chain.tip = entry;
    }
    miner.createBlock(function(err, attempt) {
      if (realTip)
        chain.tip = realTip;
      assert.noError(err);
      if (tx) {
        var redeemer = bcoin.mtx();
        redeemer.addOutput({
          address: wallet.getAddress(),
          value: utils.satoshi('25.0')
        });
        redeemer.addInput(tx, 0);
        wallet.sign(redeemer);
        attempt.addTransaction(redeemer);
      }
      callback(null, attempt.mineSync());
    });
  }

  function deleteCoins(tx) {
    if (Array.isArray(tx)) {
      tx.forEach(deleteCoins);
      return;
    }
    tx.inputs.forEach(function(input) {
      delete input.coin;
    });
  }

  it('should open chain and miner', function(cb) {
    miner.open(cb);
  });

  it('should mine a block', function(cb) {
    miner.mineBlock(function(err, block) {
      assert.noError(err);
      assert(block);
      cb();
    });
  });

  it('should mine competing chains', function(cb) {
    utils.forRangeSerial(0, 10, function(i, next) {
      mineBlock(ch1, cb1, function(err, chain1) {
        assert.noError(err);
        cb1 = chain1.txs[0];
        mineBlock(ch2, cb2, function(err, chain2) {
          assert.noError(err);
          cb2 = chain2.txs[0];
          deleteCoins(chain1.txs);
          chain.add(chain1, function(err) {
            assert.noError(err);
            deleteCoins(chain2.txs);
            chain.add(chain2, function(err) {
              assert.noError(err);
              assert(chain.tip.hash === chain1.hash('hex'));
              competingTip = chain2.hash('hex');
              chain.db.get(chain1.hash('hex'), function(err, entry1) {
                assert.noError(err);
                chain.db.get(chain2.hash('hex'), function(err, entry2) {
                  assert.noError(err);
                  assert(entry1);
                  assert(entry2);
                  ch1 = entry1;
                  ch2 = entry2;
                  chain.db.isMainChain(chain2.hash('hex'), function(err, result) {
                    assert.noError(err);
                    assert(!result);
                    next();
                  });
                });
              });
            });
          });
        });
      });
    }, cb);
  });

  it('should handle a reorg', function(cb) {
    oldTip = chain.tip;
    chain.db.get(competingTip, function(err, entry) {
      assert.noError(err);
      assert(entry);
      assert(chain.height === entry.height);
      chain.tip = entry;
      miner.mineBlock(function(err, reorg) {
        assert.noError(err);
        assert(reorg);
        chain.tip = oldTip;
        var forked = false;
        chain.once('fork', function() {
          forked = true;
        });
        deleteCoins(reorg.txs);
        chain.add(reorg, function(err) {
          assert.noError(err);
          assert(forked);
          assert(chain.tip.hash === reorg.hash('hex'));
          assert(chain.tip.chainwork.cmp(oldTip.chainwork) > 0);
          cb();
        });
      });
    });
  });

  it('should check main chain', function(cb) {
    chain.db.isMainChain(oldTip, function(err, result) {
      assert.noError(err);
      assert(!result);
      cb();
    });
  });

  it('should mine a block after a reorg', function(cb) {
    mineBlock(null, cb2, function(err, block) {
      assert.noError(err);
      deleteCoins(block.txs);
      chain.add(block, function(err) {
        assert.noError(err);
        chain.db.get(block.hash('hex'), function(err, entry) {
          assert.noError(err);
          assert(entry);
          assert(chain.tip.hash === entry.hash);
          chain.db.isMainChain(entry.hash, function(err, result) {
            assert.noError(err);
            assert(result);
            cb();
          });
        });
      });
    });
  });

  it('should fail to mine a block with coins on a side chain', function(cb) {
    mineBlock(null, cb1, function(err, block) {
      assert.noError(err);
      deleteCoins(block.txs);
      chain.add(block, function(err) {
        assert(err);
        cb();
      });
    });
  });

  it('should cleanup', function(cb) {
    constants.tx.coinbaseMaturity = 100;
    cb();
  });
});
