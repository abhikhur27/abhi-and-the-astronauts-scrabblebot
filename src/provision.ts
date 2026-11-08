// Redeem the official one-use team nonce. No login token enters source or logs.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DbConnection, tables } from './module_bindings/index.js';

const noncePath = resolve(process.argv[2] ?? 'secrets/nonce-query.json');
const tokenPath = resolve(process.argv[3] ?? 'secrets/open-lobby-token.txt');
if (existsSync(tokenPath)) throw new Error('Credential file already exists; provisioning refused to overwrite it');
const response = JSON.parse(readFileSync(noncePath, 'utf8').replace(/^\uFEFF/, ''));
const result = Array.isArray(response) ? response[0] : response;
const nonce = result?.rows?.[0]?.[0];
if (typeof nonce !== 'string' || nonce.length < 4 || nonce.length > 256) throw new Error('No usable team nonce in the private query file');
mkdirSync(dirname(tokenPath), { recursive: true });
const host = process.env.STDB_HOST ?? 'https://maincloud.spacetimedb.com';
const database = process.env.STDB_DB ?? 'scrabblebot';
const timeout = setTimeout(() => { console.error('Credential provisioning timed out'); process.exit(1); }, 30_000);
DbConnection.builder().withUri(host).withDatabaseName(database)
  .onConnect((conn, identity, token) => {
    conn.subscriptionBuilder().onApplied(() => {
      conn.reducers.claimCredential({ code: nonce }).then(() => {
        const credential = conn.db.botCredential.identity.find(identity);
        if (!credential) throw new Error('Credential claim was not confirmed');
        writeFileSync(tokenPath, token + '\n', { encoding: 'utf8', mode: 0o600, flag: 'wx' });
        clearTimeout(timeout);
        console.log(JSON.stringify({ status: 'credential-provisioned', botId: String(credential.botId), tokenFile: tokenPath, host, database }));
        conn.disconnect();
        process.exit(0);
      }).catch(() => { console.error('Credential provisioning failed'); process.exit(1); });
    }).onError(() => { console.error('Credential subscription failed'); process.exit(1); }).subscribe(tables.botCredential);
  })
  .onConnectError(() => { console.error('Credential connection failed'); process.exit(1); })
  .build();
