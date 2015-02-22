/* @flow */
'use strict';

var R = require('ramda');
var uuid = require('node-uuid');
var db = require('../services/db');
var log = require('../services/log')('transfers');
var request = require('../services/request');
var jsonld = require('../services/jsonld');
var UnprocessableEntityError = require('../errors/unprocessable-entity-error');
var InsufficientFundsError = require('../errors/insufficient-funds-error');
var NotFoundError = require('../errors/not-found-error');
var AlreadyExistsError = require('../errors/already-exists-error');

exports.fetch = function *fetch(id) {
  request.validateUriParameter('id', id, 'Uuid');
  log.debug('fetching transfer ID '+id);

  var transfer = yield db.get(['transfers', id]);
  if (!transfer) throw new NotFoundError('Unknown transfer ID');

  jsonld.setContext(this, 'transfer.jsonld');
  this.body = transfer;
};

exports.create = function *create(id) {
  var _this = this;

  request.validateUriParameter('id', id, 'Uuid');
  var transfer = yield request.validateBody(this, 'Transfer');

  if ("undefined" !== transfer.id) {
    request.assert.strictEqual(
      transfer.id,
      id,
      "Transfer ID must match the one in the URL"
    );
  } else {
    transfer.id = id;
  }

  log.debug('preparing transfer ID '+transfer.id);
  log.debug(''+transfer.source.owner+' -> '+transfer.destination.owner+' : '+transfer.destination.amount);

  yield db.transaction(function *(tr) {
    // Don't process the transfer twice
    if (yield tr.get(['transfers', transfer.id])) {
      throw new AlreadyExistsError('This transfer already exists');
    }

    // Check prerequisites
    var sender = yield tr.get(['people', transfer.source.owner]);
    var recipient = yield tr.get(['people', transfer.destination.owner]);

    if ("undefined" === typeof sender) {
      throw new UnprocessableEntityError('Sender does not exist.');
    }
    if ("undefined" === typeof recipient) {
      throw new UnprocessableEntityError('Recipient does not exist.');
    }
    if (transfer.source.amount <= 0) {
      throw new UnprocessableEntityError('Amount must be a positive number excluding zero.');
    }
    if (transfer.source.amount !== transfer.destination.amount) {
      throw new UnprocessableEntityError('Source and destination amounts do not match.');
    }
    if (sender.balance < transfer.source.amount) {
      throw new InsufficientFundsError('Sender has insufficient funds.', transfer.source.owner);
    }

    // Store transfer in database
    tr.put(['transfers', transfer.id], transfer);

    // Update balances
    log.debug('sender balance: '+sender.balance+' -> '+(+sender.balance - +transfer.destination.amount));
    log.debug('recipient balance: '+recipient.balance+' -> '+(+recipient.balance + +transfer.destination.amount));
    tr.put(['people', transfer.source.owner, 'balance'], +sender.balance - +transfer.destination.amount);
    tr.put(['people', transfer.destination.owner, 'balance'], +recipient.balance + +transfer.destination.amount);
  });

  log.debug('transfer completed');

  var getSubscriptions = R.compose(db.get.bind(db), R.prepend('people'), R.append('subscriptions'), R.of);
  var filterSubscriptions = R.compose(R.filter(R.propEq('event', 'transfer.create')), R.map(R.compose(R.head, R.values, R.head, R.values)), R.filter(R.identity), R.unnest);
  var subscriptions = filterSubscriptions([
    yield getSubscriptions(transfer.source.owner),
    yield getSubscriptions(transfer.destination.owner)
  ]);

  R.forEach(function (subscription) {
    log.debug('notifying ' + subscription.owner + ' at ' + subscription.target);
  }, subscriptions);

  this.body = transfer;
  this.status = 201;
};
