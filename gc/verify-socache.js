// Round-trip the exact ClientWelcome payload Server_v3.js sends, and report what
// the client would actually parse out of outofdate_subscribed_caches.
//
// Place this file next to your Server_v3.js (the directory that holds ./proto) and run:
//
//   node verify-socache.js <steamid64>
//
// What to look for: ownerSoid.id must be a full SteamID64 (7656119...), NOT an
// account id. If it prints the account id, the client will never attach the SO
// cache to the local player and GetElevatedState() stays "none".

const protobuf = require('protobufjs');

if (!process.argv[2]) {
    console.error('usage: node verify-socache.js <steamid64>');
    console.error('  e.g. node verify-socache.js 76561198000000001');
    process.exit(1);
}
// Your own SteamID64 -- the id the client expects in owner_soid.id.
const STEAMID = BigInt(process.argv[2]);

const root = protobuf.loadSync([
    './proto/base_gcmessages.proto',
    './proto/cstrike15_gcmessages.proto',
    './proto/econ_gcmessages.proto',
    './proto/engine_gcmessages.proto',
    './proto/gcsdk_gcmessages.proto',
    './proto/gcsystemmsgs.proto'
]);

const STEAMID64_BASE = 76561197960265728n;
function toSteamId64(id) {
    const v = BigInt(id);
    return v > 0xFFFFFFFFn ? v : STEAMID64_BASE + v;
}

function buildEconSOCache(steamid) {
    const EconAccountClient = root.lookupType('CSOEconGameAccountClient');
    const econAccountData = EconAccountClient.encode(EconAccountClient.create({
        additionalBackpackSlots: 0,
        bonusXpTimestampRefresh: 0,
        bonusXpUsedflags: 0,
        elevatedState: 5,
        elevatedTimestamp: Math.floor(Date.now() / 1000)
    })).finish();

    const PersonaData = root.lookupType('CSOPersonaDataPublic');
    const personaData = PersonaData.encode(PersonaData.create({
        playerLevel: 40,
        commendation: { cmdFriendly: 1, cmdTeaching: 2, cmdLeader: 3 },
        elevatedState: true
    })).finish();

    return {
        objects: [
            { typeId: 7, objectData: [econAccountData] },
            { typeId: 2, objectData: [personaData] }
        ],
        version: 1575,
        ownerSoid: { type: 1, id: toSteamId64(steamid) }
    };
}

const socacheSubscribed = buildEconSOCache(STEAMID);
const socacheCheck = { version: 1575, ownerSoid: { type: 1, id: toSteamId64(STEAMID) } };

const welcome = {
    version: 1575,
    outofdateSubscribedCaches: [socacheSubscribed],
    uptodateSubscribedCaches: [socacheCheck],
    currency: 0,
    balance: 0
};

const T = root.lookupType('CMsgClientWelcome');
const buf = T.encode(T.fromObject(welcome)).finish();
console.log('encoded CMsgClientWelcome: %d bytes', buf.length);

const back = T.decode(buf);
console.log('decoded keys:', Object.keys(back));

const od = back.outofdateSubscribedCaches || [];
console.log('\noutofdateSubscribedCaches: %d entry(ies)', od.length);
for (const c of od) {
    console.log('  version   =', c.version);
    console.log('  ownerSoid =', JSON.stringify(c.ownerSoid),
        c.ownerSoid && c.ownerSoid.id !== undefined
            ? '(id = ' + c.ownerSoid.id + ')' : '');
    for (const sub of (c.objects || [])) {
        console.log('    typeId=%s  objectData count=%d', sub.typeId,
            (sub.objectData || []).length);
        for (const b of (sub.objectData || [])) {
            const raw = Buffer.from(b);
            console.log('      bytes(%d): %s', raw.length,
                raw.toString('hex'));
            if (sub.typeId === 7) {
                const A = root.lookupType('CSOEconGameAccountClient');
                const o = A.decode(raw);
                console.log('      -> CSOEconGameAccountClient',
                    JSON.stringify(A.toObject(o)));
            }
            if (sub.typeId === 2) {
                const P = root.lookupType('CSOPersonaDataPublic');
                const o = P.decode(raw);
                console.log('      -> CSOPersonaDataPublic',
                    JSON.stringify(P.toObject(o)));
            }
        }
    }
}

const ut = back.uptodateSubscribedCaches || [];
console.log('\nuptodateSubscribedCaches: %d entry(ies)', ut.length);
for (const c of ut) {
    console.log('  version=%s ownerSoid=%s', c.version, JSON.stringify(c.ownerSoid));
}

console.log('\nowner_soid id matches the local SteamID?',
    od.length > 0 && String(od[0].ownerSoid && od[0].ownerSoid.id) === String(STEAMID));
