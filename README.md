# BCoin

**BCoin** is a bitcoin library which can also act as an SPV node or a full
node. It is consensus aware and is up to date with the latest BIPs: it supports
segregated witness, versionbits, and CSV. It also has preliminary support for
bip151 (peer-to-peer encryption), bip152 (compact block relay), and bip114
(MAST). It runs in node.js, but it can also be browserified.

Try it in the browser: http://bcoin.io/browser.html

## Features

- HD Wallets (using BIP44 derivation and accounts)
- Fully browserifiable
- Full block validation
- Full block database
- Fully validating mempool (stored in-memory or optionally on-disk)
- Wallet database
- HTTP server which acts as a wallet server and can also serve:
  blocks, txs (by hash/address), and utxos (by id/address).
- Full segregated witness support for block/tx validation and wallets.
- Versionbits, CSV, BIP151, BIP152, MAST support.
- SPV mode

## Install

```
$ npm install bcoin
```

## Documentation

Read the docs here: http://bcoin.io/docs/

## Example Usage

- [Creating a blockchain and mempool](#creating-a-blockchain-and-mempool)
- [Connecting to the P2P network](#connecting-to-the-p2p-network)
- [Doing and SPV sync](#doing-an-spv-sync)
- [High-level usage with the Node object](#high-level-usage-with-the-node-object)
- [Running a full node in the browser](#running-a-full-node-in-the-browser)
- [CLI Usage](#cli-usage)

### Creating a blockchain and mempool

``` js
var bcoin = require('bcoin');

bcoin.set({
  // Default network (so we can avoid passing
  // the `network` option into every object below.
  network: 'regtest',
  // Enable the global worker pool
  // for mining and transaction verification.
  useWorkers: true
});

// Start up a blockchain, mempool, and miner using in-memory
// databases (stored in a red-black tree instead of on-disk).
var chain = new bcoin.chain({ db: 'memory' });
var mempool = new bcoin.mempool({ chain: chain, db: 'memory' });
var miner = new bcoin.miner({ chain: chain, mempool: mempool });

// Open the miner (initialize the databases, etc).
// Miner will implicitly call `open` on chain and mempool.
miner.open(function(err) {
  if (err)
    throw err;

  // Create a block "attempt".
  miner.createBlock(function(err, attempt) {
    if (err)
      throw err;

    // Mine the block on the worker pool (use mine() for the master process)
    attempt.mineAsync(function(err, block) {
      if (err)
        throw err;

      // Add the block to the chain
      chain.add(block, function(err) {
        if (err)
          throw err;

        console.log('Added %s to the blockchain.', block.rhash);
        console.log(block);
      });
    });
  });
});
```

### Connecting to the P2P network

``` js
var bcoin = require('bcoin').set('main');

// Create a blockchain and store it in leveldb.
// `db` also accepts `rocksdb` and `lmdb`.
var prefix = process.env.HOME + '/my-bcoin-environment';
var chain = new bcoin.chain({ db: 'leveldb', location: prefix + '/chain' });

var mempool = new bcoin.mempool({ chain: chain, db: 'memory' });

// Create a network pool of peers with a limit of 8 peers.
var pool = new bcoin.pool({ chain: chain, mempool: mempool, size: 8 });

// Open the pool (implicitly opens mempool and chain).
pool.open(function(err) {
  if (err)
    throw err;

  // Connect, start retrieving and relaying txs
  pool.connect();

  // Start the blockchain sync.
  pool.startSync();

  // Watch the action
  chain.on('block', function(block) {
    console.log('Connected block to blockchain:');
    console.log(block);
  });

  mempool.on('tx', function(tx) {
    console.log('Added tx to mempool:');
    console.log(tx);
  });

  pool.on('tx', function(tx) {
    console.log('Saw transaction:');
    console.log(tx.rhash);
  });
});

// Start up a segnet4 sync in-memory
// while we're at it (because we can).

var tchain = new bcoin.chain({
  network: 'segnet4',
  db: 'memory'
});

var tmempool = new bcoin.mempool({
  network: 'segnet4',
  chain: tchain,
  db: 'memory'
});

var tpool = new bcoin.pool({
  network: 'segnet4',
  chain: tchain,
  mempool: tmempool,
  size: 8
});

tpool.open(function(err) {
  if (err)
    throw err;

  // Connect, start retrieving and relaying txs
  tpool.connect();

  // Start the blockchain sync.
  tpool.startSync();

  tchain.on('block', function(block) {
    console.log('Added segnet4 block:');
    console.log(block);
  });

  tmempool.on('tx', function(tx) {
    console.log('Added segnet4 tx to mempool:');
    console.log(tx);
  });

  tpool.on('tx', function(tx) {
    console.log('Saw segnet4 transaction:');
    console.log(tx);
  });
});

```

### Doing an SPV sync

``` js
var bcoin = require('bcoin').set('testnet');

// SPV chains only store the chain headers.
var chain = new bcoin.chain({
  db: 'leveldb',
  location: process.env.HOME + '/spvchain',
  spv: true
});

var pool = new bcoin.pool({
  chain: chain,
  spv: true,
  size: 8
});

var walletdb = new bcoin.walletdb({ db: 'memory' });

pool.open(function(err) {
  if (err)
    throw err;

  walletdb.open(function(err) {
    if (err)
      throw err;

    walletdb.create(function(err, wallet) {
      if (err)
        throw err;

      console.log('Created wallet with address %s', wallet.getAddress('base58'));

      // Add our address to the spv filter.
      pool.watchAddress(wallet.getAddress());

      // Connect, start retrieving and relaying txs
      pool.connect();

      // Start the blockchain sync.
      pool.startSync();

      pool.on('tx', function(tx) {
        wallet.addTX(tx);
      });

      wallet.on('balance', function(balance) {
        console.log('Balance updated.');
        console.log(bcoin.utils.btc(balance.unconfirmed));
      });
    });
  });
});
```

### High-level usage with the Node object

``` js
var bcoin = require('bcoin').set('main');

var node = bcoin.fullnode({
  prune: false,
  useCheckpoints: true,
  debug: true,
  // Primary wallet passphrase
  passsphrase: 'node',
  logLevel: 'info'
});

// We get a lot of errors sometimes,
// usually from peers hanging up on us.
// Just ignore them for now.
node.on('error', function(err) {
  ;
});

// Start the node
node.open(function(err) {
  if (err)
    throw err;

  // Create a new wallet (or get an existing one with the same ID)
  var options = {
    id: 'mywallet',
    passphrase: 'foo',
    witness: false,
    type: 'pubkeyhash'
  };

  node.createWallet(options, function(err, wallet) {
    if (err)
      throw err;

    console.log('Created wallet with address: %s', wallet.getAddress('base58'));

    // Start syncing the blockchain
    node.startSync();

    // Wait for balance and send it to a new address.
    wallet.once('balance', function(balance) {
      // Create a transaction, fill
      // it with coins, and sign it.
      var options = {
        subtractFee: true,
        outputs: [{
          address: newReceiving,
          value: balance.total
        }]
      };
      wallet.createTX(options, function(err, tx) {
        if (err)
          throw err;

        // Need to pass our passphrase back in to sign!
        wallet.sign(tx, 'foo', function(err) {
          if (err)
            throw err;

          console.log('sending tx:');
          console.log(tx);

          node.sendTX(tx, function(err) {
            if (err) {
              // Could be a reject
              // packet or a timeout.
              return console.log(err);
            }
            console.log('tx sent!');
          });
        });
      });
    });
  });
});

node.chain.on('block', function(block) {
  ;
});

node.mempool.on('tx', function(tx) {
  ;
});

node.chain.on('full', function() {
  node.mempool.getHistory(function(err, txs) {
    if (err)
      throw err;

    console.log(txs);
  });
});
```

### Running a full node in the browser

``` bash
$ cd ~/bcoin
$ make # Browserify bcoin
$ node browser/server.js 8080 # Start up a simple webserver and websocket->tcp bridge
$ chromium http://localhost:8080
```

You should see something like this: http://i.imgur.com/0pWySyZ.png

This is a simple proof-of-concept. It's not a pretty interface. I hope to see
others doing something far more interesting. A browser extension may be better:
the chrome extension API exposes raw TCP access.

### CLI Usage

``` bash
$ BCOIN_NETWORK=segnet4 node bin/node
# View the genesis block
$ node bin/bcoin-cli block 0
# View primary wallet
$ node bin/bcoin-cli wallet primary
# Send a tx
$ node bin/bcoin-cli send primary [address] 0.01
# View balance
$ node bin/bcoin-cli balance primary
# View the mempool
$ node bin/bcoin-cli mempool
```

## TX creation

Normal transactions in bcoin are immutable. The primary TX object contains a
bunch of consensus and policy checking methods. A lot of it is for internal use
and pretty boring for users of this library.

BCoin also offers a mutable transaction object (MTX). Mutable transactions
inherit from the TX object, but can also be signed and modified.

``` js
var bcoin = require('bcoin');
var assert = require('assert');
var constants = bcoin.protocol.constants;

// Create an HD master keypair with a mnemonic.
var master = bcoin.hd.fromMnemonic();

// Derive another private hd key (we don't want to use our master key!).
var key = master.derive('m/44/0/0/0/0');

// Create a "keyring" object. A keyring object is basically a key manager that
// is also able to tell you info such as: your redeem script, your scripthash,
// your program hash, your pubkey hash, your scripthash program hash, etc.
// In this case, we'll make it simple and just add one key for a
// pubkeyhash address. `getPublicKey` returns the non-hd public key.
var keyring = new bcoin.keyring({ key: key.getPublicKey() });

console.log(keyring.getAddress());

// Create a fake coinbase for our funding.
var cb = new bcoin.mtx();

// Add a typical coinbase input
cb.addInput({
  prevout: {
    hash: constants.NULL_HASH,
    index: 0
  },
  script: new bcoin.script(),
  sequence: 0xffffffff
});

// Send 50,000 satoshis to ourself.
cb.addOutput({
  address: keyring.getAddress(),
  value: 50000
});

// Create our redeeming transaction.
var tx = new bcoin.mtx();

// Add output 0 from our coinbase.
tx.addInput(cb, 0);

// Send 10,000 satoshis to ourself,
// creating a fee of 40,000 satoshis.
tx.addOutput({
  address: keyring.getAddress(),
  value: 10000
});

// Sign input 0: pass in our keyring and private key.
tx.sign(0, keyring, key);

// Commit our transaction and make it immutable.
// This turns it from an MTX into a TX object.
tx = tx.toTX();

// The transaction should now verify.
assert(tx.verify());
assert(tx.getFee() === 40000);
```

### Coin Selection

The above method works, but is pretty contrived. In reality, you probably
wouldn't select inputs and calculate the fee by hand. You would want a
change output added. BCoin has a nice method of dealing with this.

Let's try it more realistically:

``` js
var bcoin = require('bcoin');
var assert = require('assert');
var constants = bcoin.protocol.constants;

var master = bcoin.hd.fromMnemonic();
var key = master.derive('m/44/0/0/0/0');
var keyring = new bcoin.keyring({ key: key.getPublicKey() });
var cb = new bcoin.mtx();

cb.addInput({
  prevout: {
    hash: constants.NULL_HASH,
    index: 0
  },
  script: new bcoin.script(),
  sequence: 0xffffffff
});

// Send 50,000 satoshis to ourselves.
cb.addOutput({
  address: keyring.getAddress(),
  value: 50000
});

// Our available coins.
var coins = [];

// Convert the coinbase output to a Coin
// object and add it to our available coins.
// In reality you might get these coins from a wallet.
var coin = bcoin.coin.fromTX(cb, 0);
coins.push(coin);

// Create our redeeming transaction.
var tx = new bcoin.mtx();

// Send 10,000 satoshis to ourself.
tx.addOutput({
  address: keyring.getAddress(),
  value: 10000
});

// Now that we've created the output, we can do some coin selection (the output
// must be added first so we know how much money is needed and also so we can
// accurately estimate the size for fee calculation).

// Select coins from our array and add inputs.
// Calculate fee and add a change output.
tx.fill(coins, {
  // Use a rate of 10,000 satoshis per kb.
  // With the `fullnode` object, you can
  // use the fee estimator for this instead
  // of blindly guessing.
  rate: 10000,
  // Send the change back to ourselves.
  changeAddress: keyring.getAddress()
});

// Sign input 0
tx.sign(0, keyring, key);

// Commit our transaction and make it immutable.
// This turns it from an MTX into a TX.
tx = tx.toTX();

// The transaction should now verify.
assert(tx.verify());
```

## Scripting

Scripts are array-like objects with some helper functions.

``` js
var bcoin = require('bcoin');
var assert = require('assert');
var bn = bcoin.bn;
var opcodes = bcoin.script.opcodes;

var output = new bcoin.script();
output.push(opcodes.OP_DROP);
output.push(opcodes.OP_ADD);
output.push(new bn(7));
output.push(opcodes.OP_NUMEQUAL);
// Compile the script to its binary representation
// (you must do this if you change something!).
output.compile();
assert(output.getSmall(2) === 7); // compiled as OP_7

var input = new bcoin.script();
input.set(0, 'hello world'); // add some metadata
input.push(new bn(2));
input.push(new bn(5));
input.push(input.shift());
assert(input.getString(2) === 'hello world');
input.compile();

// A stack is another array-like object which contains
// only Buffers (whereas scripts contain Opcode objects).
var stack = new bcoin.stack();
input.execute(stack);
output.execute(stack);
// Verify the script was successful in its execution:
assert(stack.length === 1);
assert(bcoin.script.bool(stack.pop()) === true);
```

Using a witness would be similar, but witnesses do not get executed, they
simply _become_ the stack. The witness object itself is very similar to the
Stack object (an array-like object containing Buffers).

``` js
var witness = new bcoin.witness();
witness.push(new bn(2));
witness.push(new bn(5));
witness.push('hello world');

var stack = witness.toStack();
output.execute(stack);
```

## Wallet usage

BCoin maintains a wallet database which contains every wallet. Wallets are _not
usable_ without also using a wallet database. For testing, the wallet database
can be in-memory, but it must be there.

Wallets in bcoin use bip44. They also originally supported bip45 for multisig,
but support was removed to reduce code complexity, and also because bip45
doesn't seem to add any benefit in practice.

The wallet database can contain many different wallets, with many different
accounts, with many different addresses for each account. BCoin should
theoretically be able to scale to hundreds of thousands of
wallets/accounts/addresses.

Each account can be of a different type. You could have a pubkeyhash account,
as well as a multisig account, a witness pubkeyhash account, etc.

Note that accounts should not be accessed directly from the public API. They do
not have locks which can lead to race conditions during writes.

TODO

## HTTP API & Websocket Events

TODO

## Design

BCoin is thoroughly event driven. It has a fullnode object, but BCoin was
specifically designed so the mempool, blockchain, p2p pool, and wallet database
could all be used separately. All the fullnode object does is tie these things
together. It's essentially a huge proxying of events. The general communication
between these things looks something like this:

```
pool -> block event -> chain
pool -> tx event -> mempool
chain -> block event -> mempool/miner
chain -> tx event -> walletdb
chain -> reorg event -> walletdb/mempool/miner
mempool -> tx event -> walletdb/miner
miner -> block event -> chain
walletdb -> tx event -> websocket server
websocket server -> tx event -> websocket client
http client -> tx -> http server -> mempool
```

Not only does the loose coupling make testing easier, it ensures people can
utilize bcoin for many use cases.

### Performance

Non-javscript people reading this may think using javascript isn't a wise
descision.

#### Javascript

Javascript is inherently slow due to how dynamic it is, but modern JITs have
solved this issue using very clever optimization and dynamic recompilation
techniques. v8 in some cases can [rival the speed of C++][v8] if the code is
well-written.

#### Concurrency

BCoin runs in node.js, so the javascript code is limited to one thread. We
solve this limitation by spinning up persistent worker processes for
transaction verification (webworkers when in the browser). This ensures the
blockchain and mempool do not block the master process very much. It also means
transaction verification can be parallelized.

Strangely enough, workers are faster in the browser than they are in node since
you are allowed to share memory between threads using the transferrable api
(Uint8Arrays can be "transferred" to another thread). In node, you have to pipe
data to another process.

But of course, there is a benefit to having a multi-process architecture: the
worker processes can die on their own without disturbing the master process.

BCoin uses [secp256k1-node][secp256k1-node] for ecdsa verification, which is a
node.js binding to Pieter Wuille's blazingly fast [libsecp256k1][libsecp256k1]
library.

In the browser, bcoin will use [elliptic][elliptic], the fastest javascript
ecdsa implementation. It will obviously never beat C and hand-optimized
assembly, but it's still usable.

#### Benefits

The real feature of javascript is that your code will run almost anywhere. With
bcoin, we now have a full node that will run on almost any browser, on laptops,
on servers, on smartphones, on most devices you can imagine, even by simply
visting a webpage.

## LICENSE

This software is licensed under the MIT License.

Copyright Fedor Indutny, 2014-2016.
Copyright Christopher Jeffrey, 2014-2016.

Permission is hereby granted, free of charge, to any person obtaining a
copy of this software and associated documentation files (the
"Software"), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to permit
persons to whom the Software is furnished to do so, subject to the
following conditions:

The above copyright notice and this permission notice shall be included
in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
USE OR OTHER DEALINGS IN THE SOFTWARE.

[v8]: https://www.youtube.com/watch?v=UJPdhx5zTaw
[libsecp256k1]: https://github.com/bitcoin-core/secp256k1
[secp256k1-node]: https://github.com/cryptocoinjs/secp256k1-node
[elliptic]: https://github.com/indutny/elliptic
