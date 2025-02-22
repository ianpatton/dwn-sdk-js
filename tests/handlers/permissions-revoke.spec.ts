import { expect } from 'chai';
import sinon from 'sinon';

import type { DataStore, EventLog, EventStream, MessageStore } from '../../src/index.js';

import { Dwn } from '../../src/dwn.js';
import { DwnErrorCode } from '../../src/core/dwn-error.js';
import { Message } from '../../src/core/message.js';
import { PermissionsRevoke } from '../../src/interfaces/permissions-revoke.js';
import { TestDataGenerator } from '../utils/test-data-generator.js';
import { TestEventStream } from '../test-event-stream.js';
import { TestStores } from '../test-stores.js';
import { Time } from '../../src/utils/time.js';
import { DidKey, DidResolver } from '@web5/dids';

describe('PermissionsRevokeHandler.handle()', () => {
  let didResolver: DidResolver;
  let messageStore: MessageStore;
  let dataStore: DataStore;
  let eventLog: EventLog;
  let eventStream: EventStream;
  let dwn: Dwn;

  describe('functional tests', () => {
    before(async () => {
      didResolver = new DidResolver({ didResolvers: [DidKey] });

      // important to follow this pattern to initialize and clean the message and data store in tests
      // so that different suites can reuse the same block store and index location for testing
      const stores = TestStores.get();
      messageStore = stores.messageStore;
      dataStore = stores.dataStore;
      eventLog = stores.eventLog;

      eventStream = TestEventStream.get();

      dwn = await Dwn.create({ didResolver, messageStore, dataStore, eventLog, eventStream });
    });

    beforeEach(async () => {
      sinon.restore(); // wipe all previous stubs/spies/mocks/fakes

      // clean up before each test rather than after so that a test does not depend on other tests to do the clean up
      await messageStore.clear();
      await dataStore.clear();
      await eventLog.clear();
    });

    after(async () => {
      await dwn.close();
    });

    it('should accept a PermissionsRevoke that revokes an existing grant', async () => {
      // scenario: Alice issues a grant to Bob, then she revokes the grant.
      const alice = await TestDataGenerator.generateDidKeyPersona();
      const bob = await TestDataGenerator.generateDidKeyPersona();


      // Alice issues a grant
      const { permissionsGrant } = await TestDataGenerator.generatePermissionsGrant({
        author     : alice,
        grantedBy  : alice.did,
        grantedTo  : bob.did,
        grantedFor : alice.did,
      });
      const permissionsGrantReply = await dwn.processMessage(alice.did, permissionsGrant.message);
      expect(permissionsGrantReply.status.code).to.eq(202);

      // Alice revokes the grant
      const { permissionsRevoke } = await TestDataGenerator.generatePermissionsRevoke({
        author             : alice,
        permissionsGrantId : await Message.getCid(permissionsGrant.message)
      });
      const permissionsRevokeReply = await dwn.processMessage(alice.did, permissionsRevoke.message);
      expect(permissionsRevokeReply.status.code).to.eq(202);
    });

    it('should return 401 if authentication fails', async () => {
      const alice = await TestDataGenerator.generateDidKeyPersona();
      const { message } = await TestDataGenerator.generatePermissionsRevoke({
        author: alice,
      });

      // use a bad signature to fail authentication
      const badSignature = await TestDataGenerator.randomSignatureString();
      message.authorization.signature.signatures[0].signature = badSignature;

      const reply = await dwn.processMessage(alice.did, message);
      expect(reply.status.code).to.equal(401);
      expect(reply.status.detail).to.contain(DwnErrorCode.GeneralJwsVerifierInvalidSignature);
    });

    it('should reject with 400 if failure parsing the message', async () => {
      const alice = await TestDataGenerator.generateDidKeyPersona();
      const { message } = await TestDataGenerator.generatePermissionsRevoke();

      // stub the `parse()` function to throw an error
      sinon.stub(PermissionsRevoke, 'parse').throws('anyError');
      const reply = await dwn.processMessage(alice.did, message);

      expect(reply.status.code).to.equal(400);
    });

    it('should reject with 400 if the associated grant cannot be found', async () => {
      const alice = await TestDataGenerator.generateDidKeyPersona();

      const { permissionsRevoke } = await TestDataGenerator.generatePermissionsRevoke({
        author             : alice,
        permissionsGrantId : await TestDataGenerator.randomCborSha256Cid()
      });
      const permissionsRevokeReply = await dwn.processMessage(alice.did, permissionsRevoke.message);
      expect(permissionsRevokeReply.status.code).to.eq(400);
      expect(permissionsRevokeReply.status.detail).to.contain('Could not find PermissionsGrant');
    });

    it('should reject with 400 if the associated grant was issued after the revoke was created', async () => {
      const alice = await TestDataGenerator.generateDidKeyPersona();

      const preGrantTimeStamp = Time.getCurrentTimestamp();
      await Time.sleep(10);

      // Create grant
      const { permissionsGrant } = await TestDataGenerator.generatePermissionsGrant({
        author     : alice,
        grantedBy  : alice.did,
        grantedFor : alice.did,
      });
      const permissionsGrantReply = await dwn.processMessage(alice.did, permissionsGrant.message);
      expect(permissionsGrantReply.status.code).to.eq(202);

      // Create revoke with timestamp before grant
      const { permissionsRevoke } = await TestDataGenerator.generatePermissionsRevoke({
        author             : alice,
        permissionsGrantId : await Message.getCid(permissionsGrant.message),
        dateCreated        : preGrantTimeStamp
      });
      const permissionsRevokeReply = await dwn.processMessage(alice.did, permissionsRevoke.message);
      expect(permissionsRevokeReply.status.code).to.eq(400);
      expect(permissionsRevokeReply.status.detail).to.contain('PermissionsRevoke has earlier date than associated PermissionsGrant');
    });

    it('should reject with 401 if the revoke was not authored by the DID in the `grantedFor` of the grant', async () => {
      // scenario: Alice issues a grant. Bob tries and failes to revoke the grant.
      const alice = await TestDataGenerator.generateDidKeyPersona();
      const bob = await TestDataGenerator.generateDidKeyPersona();

      const { permissionsGrant } = await TestDataGenerator.generatePermissionsGrant({
        author     : alice,
        grantedBy  : alice.did,
        grantedFor : alice.did,
      });
      const permissionsGrantReply = await dwn.processMessage(alice.did, permissionsGrant.message);
      expect(permissionsGrantReply.status.code).to.eq(202);

      const { permissionsRevoke } = await TestDataGenerator.generatePermissionsRevoke({
        author             : bob,
        permissionsGrantId : await Message.getCid(permissionsGrant.message),
      });
      const permissionsRevokeReply = await dwn.processMessage(alice.did, permissionsRevoke.message);
      expect(permissionsRevokeReply.status.code).to.eq(401);
      expect(permissionsRevokeReply.status.detail).to.contain(DwnErrorCode.PermissionsRevokeUnauthorizedRevoke);
    });

    it('should reject with 409 if older PermissionsRevoke messages exist for the same grant', async () => {
      const alice = await TestDataGenerator.generateDidKeyPersona();

      // Create a grant
      const { permissionsGrant } = await TestDataGenerator.generatePermissionsGrant({
        author     : alice,
        grantedBy  : alice.did,
        grantedFor : alice.did,
      });
      const permissionsGrantReply = await dwn.processMessage(alice.did, permissionsGrant.message);
      expect(permissionsGrantReply.status.code).to.eq(202);

      // Revoke the grant
      const { permissionsRevoke: permissionsRevoke1 } = await TestDataGenerator.generatePermissionsRevoke({
        author             : alice,
        permissionsGrantId : await Message.getCid(permissionsGrant.message),
      });
      const permissionsRevokeReply1 = await dwn.processMessage(alice.did, permissionsRevoke1.message);
      expect(permissionsRevokeReply1.status.code).to.eq(202);

      // Try to revoke the grant again, and receive 409 because we already revoked it.
      const { permissionsRevoke: permissionsRevoke2 } = await TestDataGenerator.generatePermissionsRevoke({
        author             : alice,
        permissionsGrantId : await Message.getCid(permissionsGrant.message),
      });
      const permissionsRevokeReply2 = await dwn.processMessage(alice.did, permissionsRevoke2.message);
      expect(permissionsRevokeReply2.status.code).to.eq(409);
    });

    it('should reject with 409 if a PermissionsRevoke message exists for same grant, same revocation time, and lower lexicographic CID', async () => {
      const alice = await TestDataGenerator.generateDidKeyPersona();

      // Create a grant
      const { permissionsGrant } = await TestDataGenerator.generatePermissionsGrant({
        author     : alice,
        grantedBy  : alice.did,
        grantedFor : alice.did,
      });
      const permissionsGrantReply = await dwn.processMessage(alice.did, permissionsGrant.message);
      expect(permissionsGrantReply.status.code).to.eq(202);

      // Create two revokes with same timestamp
      const revokeTimestamp = Time.getCurrentTimestamp();
      const { permissionsRevoke: revoke1 } = await TestDataGenerator.generatePermissionsRevoke({
        author             : alice,
        permissionsGrantId : await Message.getCid(permissionsGrant.message),
        dateCreated        : revokeTimestamp,
      });
      const { permissionsRevoke: revoke2 } = await TestDataGenerator.generatePermissionsRevoke({
        author             : alice,
        permissionsGrantId : await Message.getCid(permissionsGrant.message),
        dateCreated        : revokeTimestamp,
      });

      // Sort revokes by message CID
      let revokeWithHigherLexicographic: PermissionsRevoke;
      let revokeWithLowerLexicographic: PermissionsRevoke;
      if (await Message.getCid(revoke1.message) > await Message.getCid(revoke2.message)) {
        revokeWithHigherLexicographic = revoke1;
        revokeWithLowerLexicographic = revoke2;
      } else {
        revokeWithHigherLexicographic = revoke2;
        revokeWithLowerLexicographic = revoke1;
      }

      // Process revoke with lower lexicographic value
      const permissionsRevokeReply1 = await dwn.processMessage(alice.did, revokeWithLowerLexicographic.message);
      expect(permissionsRevokeReply1.status.code).to.eq(202);

      // Process revoke with same timestamp but lower lexicographic value, receive 409
      const permissionsRevokeReply2 = await dwn.processMessage(alice.did, revokeWithHigherLexicographic.message);
      expect(permissionsRevokeReply2.status.code).to.eq(409);
    });

    it('should accept revokes that are older than the oldest existing revoke', async () => {
      const alice = await TestDataGenerator.generateDidKeyPersona();

      // Create a grant
      const { permissionsGrant } = await TestDataGenerator.generatePermissionsGrant({
        author     : alice,
        grantedBy  : alice.did,
        grantedFor : alice.did,
      });
      const permissionsGrantReply = await dwn.processMessage(alice.did, permissionsGrant.message);
      expect(permissionsGrantReply.status.code).to.eq(202);

      // Pre-create a Revoke message with earlier timestamp, to be processed later
      const { permissionsRevoke: permissionsRevoke1 } = await TestDataGenerator.generatePermissionsRevoke({
        author             : alice,
        permissionsGrantId : await Message.getCid(permissionsGrant.message),
      });

      await Time.minimalSleep();

      // Revoke the grant using a later timestamp than the pre-created revoke
      const { permissionsRevoke: permissionsRevoke2 } = await TestDataGenerator.generatePermissionsRevoke({
        author             : alice,
        permissionsGrantId : await Message.getCid(permissionsGrant.message),
      });
      const permissionsRevokeReply2 = await dwn.processMessage(alice.did, permissionsRevoke2.message);
      expect(permissionsRevokeReply2.status.code).to.eq(202);

      // Process the pre-created Revoke
      const permissionsRevokeReply1 = await dwn.processMessage(alice.did, permissionsRevoke1.message);
      expect(permissionsRevokeReply1.status.code).to.eq(202);
    });

    describe('event log', () => {
      it('should add event for PermissionsRevoke', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();

        // Create a grant, adding one event
        const { permissionsGrant } = await TestDataGenerator.generatePermissionsGrant({
          author     : alice,
          grantedBy  : alice.did,
          grantedFor : alice.did,
        });
        const permissionsGrantReply = await dwn.processMessage(alice.did, permissionsGrant.message);
        expect(permissionsGrantReply.status.code).to.eq(202);
        let { events } = await eventLog.getEvents(alice.did);
        expect(events.length).to.equal(1);

        // Revoke the grant, adding a second event
        const { permissionsRevoke } = await TestDataGenerator.generatePermissionsRevoke({
          author             : alice,
          permissionsGrantId : await Message.getCid(permissionsGrant.message),
        });
        const reply = await dwn.processMessage(alice.did, permissionsRevoke.message);
        expect(reply.status.code).to.equal(202);

        ({ events } = await eventLog.getEvents(alice.did));
        expect(events.length).to.equal(2);

        // The revoke should be the second event
        const messageCid = await Message.getCid(permissionsRevoke.message);
        expect(events[1]).to.equal(messageCid);
      });

      it('should remove events for existing PermissionsRevoke messages with timestamp after the incoming message', async () => {
        // scenario: A grant is issued, adding one event. Then the grant is revoked, adding another event.
        //           Then, a slightly earlier revoke is processed, causing the existing revoke to be purged.
        const alice = await TestDataGenerator.generateDidKeyPersona();

        // Create a grant, adding one event
        const { permissionsGrant } = await TestDataGenerator.generatePermissionsGrant({
          author     : alice,
          grantedBy  : alice.did,
          grantedFor : alice.did,
        });
        const permissionsGrantReply = await dwn.processMessage(alice.did, permissionsGrant.message);
        expect(permissionsGrantReply.status.code).to.eq(202);
        let { events } = await eventLog.getEvents(alice.did);
        expect(events.length).to.equal(1);

        // Pre-create a Revoke message with earlier timestamp, to be processed later
        const { permissionsRevoke: permissionsRevoke1 } = await TestDataGenerator.generatePermissionsRevoke({
          author             : alice,
          permissionsGrantId : await Message.getCid(permissionsGrant.message),
        });

        await Time.sleep(10);

        // Revoke the grant using a later timestamp than the pre-created revoke
        const { permissionsRevoke: permissionsRevoke2 } = await TestDataGenerator.generatePermissionsRevoke({
          author             : alice,
          permissionsGrantId : await Message.getCid(permissionsGrant.message),
        });
        const permissionsRevokeReply2 = await dwn.processMessage(alice.did, permissionsRevoke2.message);
        expect(permissionsRevokeReply2.status.code).to.eq(202);

        // An event is added for the revoke
        const permissionsRevokeCid2 = await Message.getCid(permissionsRevoke2.message);
        ({ events } = await eventLog.getEvents(alice.did));
        expect(events.length).to.equal(2);
        expect(events[1]).to.equal(permissionsRevokeCid2);

        // Process the pre-created Revoke
        const permissionsRevokeReply1 = await dwn.processMessage(alice.did, permissionsRevoke1.message);
        expect(permissionsRevokeReply1.status.code).to.eq(202);

        // The existing Revoke event is purged from the eventLog. The pre-created Revoke is added to the eventLog
        const permissionsRevokeCid1 = await Message.getCid(permissionsRevoke1.message);
        ({ events } = await eventLog.getEvents(alice.did));
        expect(events.length).to.equal(2);
        expect(events[1]).to.equal(permissionsRevokeCid1);
      });
    });
  });
});