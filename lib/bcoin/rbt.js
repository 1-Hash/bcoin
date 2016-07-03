/*!
 * rbt.js - iterative red black tree for bcoin
 * Copyright (c) 2016, Christopher Jeffrey (MIT License).
 * https://github.com/bcoin-org/bcoin
 */

'use strict';

var utils = require('./utils');
var assert = utils.assert;
var DUMMY = new Buffer([0]);
var RED = 0;
var BLACK = 1;
var SENTINEL;

/**
 * An iterative red black tree.
 * Used for the mempool. Many of its
 * options, parameters, and methods
 * mimic the leveldown interface.
 * @exports RBT
 * @constructor
 * @param {String?} location - Phony location.
 * @param {Object?} options
 * @param {Function} options.compare - Comparator.
 */

function RBT(location, options) {
  if (!(this instanceof RBT))
    return new RBT(location, options);

  if (!options)
    options = {};

  this.options = options;
  this.root = SENTINEL;
  this.compare = options.compare || utils.cmp;
}

/**
 * Do a key lookup.
 * @param {Buffer|String} key
 * @returns {Buffer?} value
 */

RBT.prototype.search = function search(key) {
  var current = this.root;
  var cmp;

  if (typeof key === 'string')
    key = new Buffer(key, 'ascii');

  while (!current.isNull()) {
    cmp = this.compare(key, current.key);

    if (cmp === 0)
      return current.value;

    if (cmp < 0)
      current = current.left;
    else
      current = current.right;
  }
};

/**
 * Insert a record.
 * @param {Buffer|String} key
 * @param {Buffer} value
 */

RBT.prototype.insert = function insert(key, value) {
  var current = this.root;
  var left = false;
  var parent, cmp, node;

  if (typeof key === 'string')
    key = new Buffer(key, 'ascii');

  if (typeof value === 'string')
    value = new Buffer(value, 'utf8');

  while (!current.isNull()) {
    cmp = this.compare(key, current.key);

    if (cmp === 0) {
      current.value = value;
      return;
    }

    parent = current;

    if (cmp < 0) {
      left = true;
      current = current.left;
    } else {
      left = false;
      current = current.right;
    }
  }

  node = new RBTNode(key, value);

  if (!parent) {
    this.root = node;
    this.insertFixup(node);
    return;
  }

  node.parent = parent;

  if (left)
    parent.left = node;
  else
    parent.right = node;

  this.insertFixup(node);
};

/**
 * Repaint necessary nodes after insertion.
 * @private
 * @param {RBTNode} x
 */

RBT.prototype.insertFixup = function insertFixup(x) {
  var y;

  x.color = RED;

  while (x !== this.root && x.parent.color === RED) {
    if (x.parent === x.parent.parent.left) {
      y = x.parent.parent.right;
      if (!y.isNull() && y.color === RED) {
        x.parent.color = BLACK;
        y.color = BLACK;
        x.parent.parent.color = RED;
        x = x.parent.parent;
      } else {
        if (x === x.parent.right) {
          x = x.parent;
          this.rotl(x);
        }
        x.parent.color = BLACK;
        x.parent.parent.color = RED;
        this.rotr(x.parent.parent);
      }
    } else {
      y = x.parent.parent.left;
      if (!y.isNull() && y.color === RED) {
        x.parent.color = BLACK;
        y.color = BLACK;
        x.parent.parent.color = RED;
        x = x.parent.parent;
      } else {
        if (x === x.parent.left) {
          x = x.parent;
          this.rotr(x);
        }
        x.parent.color = BLACK;
        x.parent.parent.color = RED;
        this.rotl(x.parent.parent);
      }
    }
  }

  this.root.color = BLACK;
};

/**
 * Remove a record.
 * @param {Buffer|String} key
 * @returns {Boolean}
 */

RBT.prototype.remove = function remove(key) {
  var current = this.root;
  var cmp;

  if (typeof key === 'string')
    key = new Buffer(key, 'ascii');

  while (!current.isNull()) {
    cmp = this.compare(key, current.key);

    if (cmp === 0) {
      this.removeNode(current);
      return true;
    }

    if (cmp < 0)
      current = current.left;
    else
      current = current.right;
  }

  return false;
};

/**
 * Remove a single node.
 * @private
 * @param {RBTNode} z
 */

RBT.prototype.removeNode = function removeNode(z) {
  var y = z;
  var x;

  if (!z.left.isNull() && !z.right.isNull())
    y = this.successor(z);

  x = y.left.isNull() ? y.right : y.left;
  x.parent = y.parent;

  if (y.parent.isNull()) {
    this.root = x;
  } else {
    if (y === y.parent.left)
      y.parent.left = x;
    else
      y.parent.right = x;
  }

  if (y !== z) {
    z.key = y.key;
    z.value = y.value;
  }

  if (y.color === BLACK)
    this.removeFixup(x);
};

/**
 * Repaint necessary nodes after removal.
 * @private
 * @param {RBTNode} x
 */

RBT.prototype.removeFixup = function removeFixup(x) {
  var w;

  while (x !== this.root && x.color === BLACK) {
    if (x === x.parent.left) {
      w = x.parent.right;

      if (w.color === RED) {
        w.color = BLACK;
        x.parent.color = RED;
        this.rotl(x.parent);
        w = x.parent.right;
      }

      if (w.left.color === BLACK && w.right.color === BLACK) {
        w.color = RED;
        x = x.parent;
      } else {
        if (w.right.color === BLACK) {
          w.left.color = BLACK;
          w.color = RED;
          this.rotr(w);
          w = x.parent.right;
        }
        w.color = x.parent.color;
        x.parent.color = BLACK;
        w.right.color = BLACK;
        this.rotl(x.parent);
        x = this.root;
      }
    } else {
      w = x.parent.left;

      if (w.color === RED) {
        w.color = BLACK;
        x.parent.color = RED;
        this.rotr(x.parent);
        w = x.parent.left;
      }

      if (w.right.color === BLACK && w.left.color === BLACK) {
        w.color = RED;
        x = x.parent;
      } else {
        if (w.left.color === BLACK) {
          w.right.color = BLACK;
          w.color = RED;
          this.rotl(w);
          w = x.parent.left;
        }
        w.color = x.parent.color;
        x.parent.color = BLACK;
        w.left.color = BLACK;
        this.rotr(x.parent);
        x = this.root;
      }
    }
  }

  x.color = BLACK;
};

/**
 * Do a left rotate.
 * @private
 * @param {RBTNode} x
 */

RBT.prototype.rotl = function rotl(x) {
  var y = x.right;
  x.right = y.left;

  if (!y.left.isNull())
    y.left.parent = x;

  y.parent = x.parent;

  if (x.parent.isNull()) {
    this.root = y;
  } else {
    if (x === x.parent.left)
      x.parent.left = y;
    else
      x.parent.right = y;
  }

  y.left = x;
  x.parent = y;
};

/**
 * Do a right rotate.
 * @private
 * @param {RBTNode} x
 */

RBT.prototype.rotr = function rotr(x) {
  var y = x.left;
  x.left = y.right;

  if (!y.right.isNull())
    y.right.parent = x;

  y.parent = x.parent;

  if (x.parent.isNull()) {
    this.root = y;
  } else {
    if (x === x.parent.right)
      x.parent.right = y;
    else
      x.parent.left = y;
  }

  y.right = x;
  x.parent = y;
};

/**
 * Minimum subtree.
 * @private
 * @param {RBTNode} z
 * @returns {RBTNode}
 */

RBT.prototype.min = function min(z) {
  while (!z.left.isNull())
    z = z.left;
  return z;
};

/**
 * Maximum subtree.
 * @private
 * @param {RBTNode} z
 * @returns {RBTNode}
 */

RBT.prototype.max = function max(z) {
  while (!z.right.isNull())
    z = z.right;
  return z;
};

/**
 * Successor node.
 * @private
 * @param {RBTNode} x
 * @returns {RBTNode}
 */

RBT.prototype.successor = function successor(x) {
  var y;
  if (!x.right.isNull()) {
    x = x.right;
    while (!x.left.isNull())
      x = x.left;
    return x;
  }
  y = x.parent;
  while (!y.isNull() && x === y.right) {
    x = y;
    y = y.parent;
  }
  return y;
};

/**
 * Predecessor node.
 * @private
 * @param {RBTNode} x
 * @returns {RBTNode}
 */

RBT.prototype.predecessor = function predecessor(x) {
  var y;
  if (!x.left.isNull()) {
    x = x.left;
    while (!x.right.isNull())
      x = x.right;
    return x;
  }
  y = x.parent;
  while (!y.isNull() && x === y.left) {
    x = y;
    y = y.parent;
  }
  return y;
};

/**
 * Take a snapshot and return a cloned root node.
 * @returns {RBTNode}
 */

RBT.prototype.snapshot = function snapshot() {
  var current = this.root;
  var stack = [];
  var left = true;
  var parent, copy, snapshot;

  for (;;) {
    if (!current.isNull()) {
      if (left) {
        copy = current.clone();
        if (parent)
          parent.left = copy;
        else
          snapshot = copy;
      } else {
        copy = current.clone();
        if (parent)
          parent.right = copy;
        else
          snapshot = copy;
      }
      stack.push(copy);
      parent = copy;
      left = true;
      current = current.left;
      continue;
    }

    if (stack.length === 0)
      break;

    current = stack.pop();
    parent = current;
    left = false;
    current = current.right;
  }

  return snapshot;
};

/**
 * Traverse the key and filter records.
 * @param {Function} test
 * @returns {RBTNode[]} Records.
 */

RBT.prototype.traverse = function traverse(test) {
  var current = this.min(this.root);
  var items = [];

  while (!current.isNull()) {
    if (test(current))
      items.push(current.copy());
    current = this.successor(current);
  }

  return items;
};

/**
 * Dump all records.
 * @returns {RBTNode[]} Records.
 */

RBT.prototype.dump = function dump() {
  return this.traverse(function() { return true; });
};

/**
 * Traverse between a range of keys and collect records.
 * @param {Buffer} gte
 * @param {Buffer} lte
 * @returns {RBTNode[]} Records.
 */

RBT.prototype.range = function range(gte, lte) {
  var root = this.root;
  var current = SENTINEL;
  var items = [];
  var cmp;

  if (typeof gte === 'string')
    gte = new Buffer(gte, 'ascii');

  if (typeof lte === 'string')
    lte = new Buffer(lte, 'ascii');

  if (gte) {
    // Find the node closest to our gte key.
    while (!root.isNull()) {
      cmp = this.compare(gte, root.key);

      if (cmp === 0) {
        current = root;
        break;
      }

      if (cmp < 0) {
        current = root;
        root = root.left;
      } else {
        root = root.right;
      }
    }
  } else {
    // Descend into the left subtree.
    current = this.min(root);
  }

  // Walk the tree in order.
  while (!current.isNull()) {
    if (lte) {
      // Stop once we hit a key above our lte key.
      cmp = this.compare(current.key, lte);
      if (cmp > 0)
        break;
    }

    items.push(current.copy());
    current = this.successor(current);
  }

  return items;
};

/**
 * Open the database (leveldown method).
 * @param {Object?} options
 * @param {Function} callback
 */

RBT.prototype.open = function open(options, callback) {
  if (!callback) {
    callback = options;
    options = null;
  }

  if (!options)
    options = {};

  this.options = options;

  return utils.nextTick(callback);
};

/**
 * Close the database (leveldown method).
 * @param {Function} callback
 */

RBT.prototype.close = function close(callback) {
  return utils.nextTick(callback);
};

/**
 * Retrieve a record (leveldown method).
 * @param {Buffer|String} key
 * @param {Object?} options
 * @param {Function} callback - Returns [Error, Buffer].
 */

RBT.prototype.get = function get(key, options, callback) {
  var value, err;

  if (!callback) {
    callback = options;
    options = null;
  }

  if (!options)
    options = {};

  value = this.search(key);

  if (!value) {
    err = new Error('RBT_NOTFOUND: Key not found.');
    err.notFound = true;
    err.type = 'NotFoundError';
    return utils.asyncify(callback)(err);
  }

  if (options.asBuffer === false)
    value = value.toString('utf8');

  return utils.asyncify(callback)(null, value);
};

/**
 * Insert a record (leveldown method).
 * @param {Buffer|String} key
 * @param {Buffer} value
 * @param {Object?} options
 * @param {Function} callback
 */

RBT.prototype.put = function put(key, value, options, callback) {
  if (!callback) {
    callback = options;
    options = null;
  }

  this.insert(key, value);

  return utils.nextTick(callback);
};

/**
 * Remove a record (leveldown method).
 * @param {Buffer|String} key
 * @param {Object?} options
 * @param {Function} callback
 */

RBT.prototype.del = function del(key, options, callback) {
  if (!callback) {
    callback = options;
    options = null;
  }

  this.remove(key);

  return utils.nextTick(callback);
};

/**
 * Create an atomic batch (leveldown method).
 * @see Leveldown.Batch
 * @param {Object[]?} ops
 * @param {Object?} options
 * @param {Function} callback
 * @returns {Leveldown.Batch}
 */

RBT.prototype.batch = function batch(ops, options, callback) {
  var batch;

  if (!callback) {
    callback = options;
    options = null;
  }

  if (!options)
    options = {};

  batch = new Batch(this, options);

  if (ops) {
    batch.ops = ops.slice();
    return batch.write(callback);
  }

  return batch;
};

/**
 * Create an iterator (leveldown method).
 * @param {Object} options - See {Leveldown.Iterator}.
 * @returns {Leveldown.Iterator}.
 */

RBT.prototype.iterator = function iterator(options) {
  return new Iterator(this, options);
};

/**
 * Get a database property (leveldown method) (NOP).
 * @param {String} name - Property name.
 * @returns {String}
 */

RBT.prototype.getProperty = function getProperty(name) {
  return '';
};

/**
 * Calculate approximate database size (leveldown method).
 * @param {Buffer|String} start - Start key.
 * @param {Buffer|String} end - End key.
 * @param {Function} callback - Returns [Error, Number].
 */

RBT.prototype.approximateSize = function approximateSize(start, end, callback) {
  var items = this.range(start, end);
  var size = 0;
  var i, item;

  for (i = 0; i < items.length; i++) {
    item = items[i];
    size += item.key.length;
    size += item.value.length;
  }

  return utils.asyncify(callback)(null, size);
};

/**
 * Destroy the database (leveldown function) (NOP).
 * @param {String} location
 * @param {Function} callback
 */

RBT.destroy = function destroy(location, callback) {
  return utils.nextTick(callback);
};

/**
 * Repair the database (leveldown function) (NOP).
 * @param {String} location
 * @param {Function} callback
 */

RBT.repair = function repair(location, callback) {
  return utils.nextTick(callback);
};

/**
 * RBT Node
 * @constructor
 * @private
 * @param {Buffer} key
 * @param {Buffer} value
 * @property {Buffer} key
 * @property {Buffer} value
 * @property {Number} color
 * @property {RBTNode|RBTSentinel} parent
 * @property {RBTNode|RBTSentinel} left
 * @property {RBTNode|RBTSentinel} right
 */

function RBTNode(key, value) {
  this.key = key;
  this.value = value;
  this.color = RED;
  this.parent = SENTINEL;
  this.left = SENTINEL;
  this.right = SENTINEL;
}

/**
 * Clone the node.
 * @returns {RBTNode}
 */

RBTNode.prototype.clone = function clone() {
  var node = new RBTNode(this.key, this.value);
  node.color = this.color;
  node.parent = this.parent;
  node.left = this.left;
  node.right = this.right;
  return node;
};

/**
 * Clone the node (key/value only).
 * @returns {RBTData}
 */

RBTNode.prototype.copy = function copy() {
  return new RBTData(this.key, this.value);
};

/**
 * Inspect the rbt node.
 * @returns {Object}
 */

RBTNode.prototype.inspect = function inspect() {
  return {
    key: this.key.toString('ascii'),
    value: this.value.toString('hex'),
    color: this.color === RED ? 'red' : 'black',
    left: this.left,
    right: this.right
  };
};

/**
 * Test whether the node is a leaf.
 * Always returns false.
 * @returns {Boolean}
 */

RBTNode.prototype.isNull = function isNull() {
  return false;
};

/**
 * RBT Sentinel Node
 * @constructor
 * @property {null} key
 * @property {null} value
 * @property {Number} [color=BLACK]
 * @property {null} parent
 * @property {null} left
 * @property {null} right
 */

function RBTSentinel() {
  this.key = null;
  this.value = null;
  this.color = BLACK;
  this.parent = null;
  this.left = null;
  this.right = null;
}

/**
 * Inspect the rbt node.
 * @returns {String}
 */

RBTSentinel.prototype.inspect = function inspect() {
  return 'NIL';
};

/**
 * Test whether the node is a leaf.
 * Always returns true.
 * @returns {Boolean}
 */

RBTSentinel.prototype.isNull = function isNull() {
  return true;
};

/**
 * RBT key/value pair
 * @constructor
 * @param {Buffer} key
 * @param {Buffer} value
 * @property {Buffer} key
 * @property {Buffer} value
 */

function RBTData(key, value) {
  this.key = key;
  this.value = value;
}

/**
 * Inspect the rbt data.
 * @returns {Object}
 */

RBTData.prototype.inspect = function inspect() {
  return {
    key: this.key.toString('ascii'),
    value: this.value.toString('hex')
  };
};

/**
 * Batch
 * @constructor
 * @private
 * @param {RBT} tree
 * @param {Object?} options
 */

function Batch(tree, options) {
  this.options = options || {};
  this.ops = [];
  this.tree = tree;
}

/**
 * Insert a record.
 * @param {Buffer|String} key
 * @param {Buffer} value
 */

Batch.prototype.put = function(key, value) {
  assert(this.tree, 'Already written.');
  this.ops.push(new BatchOp('put', key, value));
  return this;
};

/**
 * Remove a record.
 * @param {Buffer|String} key
 */

Batch.prototype.del = function del(key) {
  assert(this.tree, 'Already written.');
  this.ops.push(new BatchOp('del', key));
  return this;
};

/**
 * Commit the batch.
 * @param {Function} callback
 */

Batch.prototype.write = function write(callback) {
  var i, op;

  if (!this.tree)
    return callback(new Error('Already written.'));

  for (i = 0; i < this.ops.length; i++) {
    op = this.ops[i];
    if (op.type === 'put')
      this.tree.insert(op.key, op.value);
    else if (op.type === 'del')
      this.tree.remove(op.key);
    else
      assert(false);
  }

  this.ops.length = 0;
  this.ops = null;
  this.options = null;
  this.tree = null;

  utils.nextTick(callback);

  return this;
};

/**
 * Clear batch of all ops.
 */

Batch.prototype.clear = function clear() {
  assert(this.tree, 'Already written.');
  this.ops.length = 0;
  return this;
};

/**
 * Batch Operation
 * @constructor
 * @private
 * @param {String} type
 * @param {Buffer} key
 * @param {Buffer|null} value
 */

function BatchOp(type, key, value) {
  this.type = type;
  this.key = key;
  this.value = value;
}

/**
 * Iterator
 * @constructor
 * @private
 * @param {RBT} tree
 * @param {Object?} options
 */

function Iterator(tree, options) {
  if (!options)
    options = {};

  assert(!options.lt, 'LT is not implemented.');
  assert(!options.gt, 'GT is not implemented.');

  this.options = {
    keys: options.keys,
    values: options.values,
    gte: options.gte || options.start,
    lte: options.lte || options.end,
    keyAsBuffer: options.keyAsBuffer,
    valueAsBuffer: options.valueAsBuffer,
    reverse: options.reverse,
    limit: options.limit
  };

  this.tree = tree;
  this.ended = false;
  this.snapshot = this.tree.range(this.options.gte, this.options.lte);
  this.index = this.options.reverse ? this.snapshot.length - 1 : 0;
  this.total = 0;
}

/**
 * Seek to the next key.
 * @param {Function} callback
 */

Iterator.prototype.next = function(callback) {
  var item, key, value;

  if (this.ended)
    return utils.asyncify(callback)(new Error('Cannot call next after end.'));

  if (this.options.reverse)
    item = this.snapshot[this.index--];
  else
    item = this.snapshot[this.index++];

  if (this.options.limit != null) {
    if (this.total++ >= this.options.limit) {
      this._end();
      return utils.nextTick(callback);
    }
  }

  if (!item) {
    this._end();
    return utils.nextTick(callback);
  }

  key = item.key;
  value = item.value;

  if (this.options.keys === false)
    key = DUMMY;

  if (this.options.values === false)
    value = DUMMY;

  if (this.options.keyAsBuffer === false)
    key = key.toString('ascii');

  if (this.options.valueAsBuffer === false)
    value = value.toString('utf8');

  utils.asyncify(callback)(null, key, value);
};

/**
 * Seek to a key gte to `key`.
 * @param {String|Buffer} key
 */

Iterator.prototype.seek = function seek(key) {
  var self = this;

  assert(!this.ended, 'Already ended.');

  if (typeof key === 'string')
    key = new Buffer(key, 'ascii');

  this.index = utils.binarySearch(this.snapshot, key, function(a, b) {
    return self.tree.compare(a.key, b);
  }, true);
};

/**
 * Clean up the iterator.
 * @private
 */

Iterator.prototype._end = function end() {
  if (!this.tree)
    return;

  this.tree = null;
  this.snapshot.length = 0;
  this.snapshot = null;
};

/**
 * End the iterator. Free up snapshot.
 * @param {Buffer} callback
 */

Iterator.prototype.end = function end(callback) {
  if (this.ended)
    return utils.asyncify(callback)(new Error('Already ended.'));

  this.ended = true;
  this._end();

  return utils.nextTick(callback);
};

/*
 * Helpers
 */

SENTINEL = new RBTSentinel();

/*
 * Expose
 */

module.exports = RBT;
