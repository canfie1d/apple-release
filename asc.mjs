#!/usr/bin/env node
// asc: App Store Connect API helper for TestFlight and store metadata. Zero dependencies (Node 20+).
//
//   asc.mjs init      <app-dir>                          create <app-dir>/appstore/ (prefilled from App Store Connect when credentials exist)
//   asc.mjs testflight <app-dir> [--since ISO] [--platforms IOS,MAC_OS] [--notes FILE] [--wait-minutes 45] [--dry-run]
//   asc.mjs metadata  <app-dir> [--platforms IOS,MAC_OS] [--attach-build] [--dry-run]
//   asc.mjs status    <app-dir>
//
// Credentials (App Store Connect API key): ASC_KEY_ID, ASC_ISSUER_ID, ASC_KEY_PATH (.p8).
// Per-app config lives in <app-dir>/appstore/ (see README.md). Bundle id, version and Mac support come from app.json.

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { createPrivateKey, sign } from 'node:crypto';
import { join, resolve } from 'node:path';
import { execSync } from 'node:child_process';

const API = 'https://api.appstoreconnect.apple.com';
const argv = process.argv.slice(2);
const cmd = argv[0];
const positional = argv.slice(1).filter((a, i, arr) => !a.startsWith('--') && !(arr[i - 1] || '').match(/^--(since|platforms|notes|wait-minutes)$/));
const flag = (n) => argv.includes(`--${n}`);
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const DRY = flag('dry-run');
const log = (...a) => console.log(...a);
const warn = (...a) => console.warn('warning:', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- auth + http ----------
let cached = { t: 0, v: '' };
function jwt() {
  const { ASC_KEY_ID: kid, ASC_ISSUER_ID: iss, ASC_KEY_PATH: path } = process.env;
  if (!kid || !iss || !path) throw new Error('Set ASC_KEY_ID, ASC_ISSUER_ID and ASC_KEY_PATH (App Store Connect API key).');
  if (Date.now() - cached.t < 10 * 60 * 1000) return cached.v;
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const data = `${b64({ alg: 'ES256', kid, typ: 'JWT' })}.${b64({ iss, iat: now, exp: now + 15 * 60, aud: 'appstoreconnect-v1' })}`;
  const key = createPrivateKey(readFileSync(path.replace(/^~/, process.env.HOME || '~')));
  const sig = sign('sha256', Buffer.from(data), { key, dsaEncoding: 'ieee-p1363' }).toString('base64url');
  cached = { t: Date.now(), v: `${data}.${sig}` };
  return cached.v;
}
async function api(method, path, body, { allow = [] } = {}) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(path.startsWith('http') ? path : API + path, {
      method,
      headers: { Authorization: `Bearer ${jwt()}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    if ((res.status === 429 || res.status >= 500) && attempt < 3) { await sleep(2000 * (attempt + 1)); continue; }
    const text = await res.text();
    const json = text ? JSON.parse(text) : {};
    if (res.ok) return json;
    if (allow.includes(res.status)) return { __status: res.status, ...json };
    const detail = (json.errors || []).map((e) => `${e.title}: ${e.detail}`).join('; ') || text;
    const err = new Error(`${method} ${path} -> ${res.status} ${detail}`);
    err.status = res.status;
    throw err;
  }
}
async function list(path) {
  const out = []; let url = path + (path.includes('?') ? '&' : '?') + 'limit=200';
  while (url) { const j = await api('GET', url); out.push(...(j.data || [])); out.__included = (out.__included || []).concat(j.included || []); url = j.links?.next; }
  return out;
}
const write = async (method, path, body, opts) => { if (DRY) { log(`  [dry-run] ${method} ${path}`); return { data: { id: 'dry-run' } }; } return api(method, path, body, opts); };

// ---------- app config ----------
function loadApp(dir) {
  const root = resolve((dir || '').replace(/^~/, process.env.HOME || '~'));
  const expo = JSON.parse(readFileSync(join(root, 'app.json'), 'utf8')).expo;
  const mac = (expo.plugins || []).some((p) => String(Array.isArray(p) ? p[0] : p).includes('with-mac-catalyst'));
  const asDir = join(root, 'appstore');
  const readJson = (f, d) => (existsSync(join(asDir, f)) ? JSON.parse(readFileSync(join(asDir, f), 'utf8')) : d);
  return { root, name: expo.name, bundleId: expo.ios.bundleIdentifier, version: expo.version, mac, asDir, readJson };
}
function platformsFor(app) {
  const wanted = (opt('platforms', '') || '').split(',').filter(Boolean);
  const all = app.mac ? ['IOS', 'MAC_OS'] : ['IOS'];
  return wanted.length ? all.filter((p) => wanted.includes(p)) : all;
}
async function findApp(app) {
  const r = await api('GET', `/v1/apps?filter[bundleId]=${encodeURIComponent(app.bundleId)}`);
  if (!r.data?.length) throw new Error(`No App Store Connect app with bundle id ${app.bundleId}. Create the app record first.`);
  return r.data[0];
}
const isTodo = (v) => v === undefined || v === null || v === '' || (typeof v === 'string' && v.trim().toUpperCase().startsWith('TODO'));

// ---------- release notes ----------
function gitNotes(root) {
  const sh = (c) => { try { return execSync(c, { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch { return ''; } };
  const last = sh('git describe --tags --match "apple-*" --abbrev=0');
  const range = last ? `${last}..HEAD` : '-n 15';
  const subjects = sh(`git log --no-merges --pretty=format:%s ${range} -- .`).split('\n').map((s) => s.replace(/\s*\(#\d+\)$/, '').trim()).filter(Boolean);
  return subjects.length ? subjects.map((s) => `• ${s}`).join('\n') : 'Bug fixes and improvements.';
}
function releaseNotes(app) {
  const file = opt('notes') || join(app.asDir, 'release-notes.txt');
  if (existsSync(file)) { const t = readFileSync(file, 'utf8').trim(); if (t && !isTodo(t)) return t.slice(0, 4000); }
  return gitNotes(app.root).slice(0, 4000);
}

// ---------- builds ----------
async function latestBuild(appId, platform, sinceMs) {
  const r = await api('GET', `/v1/builds?filter[app]=${appId}&sort=-uploadedDate&limit=25&include=preReleaseVersion`);
  const pre = Object.fromEntries((r.included || []).filter((i) => i.type === 'preReleaseVersions').map((i) => [i.id, i.attributes]));
  return (r.data || []).find((b) => {
    const p = pre[b.relationships?.preReleaseVersion?.data?.id];
    return p?.platform === platform && (!sinceMs || Date.parse(b.attributes.uploadedDate) >= sinceMs);
  });
}
async function waitForBuild(appId, platform, sinceMs, waitMin) {
  const deadline = Date.now() + waitMin * 60 * 1000;
  let state = '';
  while (Date.now() < deadline) {
    const b = await latestBuild(appId, platform, sinceMs);
    if (b) {
      const s = b.attributes.processingState;
      if (s !== state) { log(`  ${platform} build ${b.attributes.version}: ${s}`); state = s; }
      if (s === 'VALID') return b;
      if (s === 'FAILED' || s === 'INVALID') throw new Error(`${platform} build ${b.attributes.version} processing ${s}`);
    } else if (state !== 'none') { log(`  ${platform}: waiting for the uploaded build to appear`); state = 'none'; }
    await sleep(30000);
  }
  throw new Error(`Timed out waiting for the ${platform} build to finish processing`);
}

// ---------- testflight ----------
async function ensureGroup(appId, g, groups) {
  let found = groups.find((x) => x.attributes.name === g.name);
  const internal = g.internal !== false;
  if (!found) {
    log(`  creating group "${g.name}" (${internal ? 'internal' : 'external'})`);
    const attrs = { name: g.name, isInternalGroup: internal, feedbackEnabled: g.feedbackEnabled !== false };
    if (internal) attrs.hasAccessToAllBuilds = g.allBuilds !== false;
    else attrs.publicLinkEnabled = !!g.publicLink;
    const r = await write('POST', '/v1/betaGroups', { data: { type: 'betaGroups', attributes: attrs, relationships: { app: { data: { type: 'apps', id: appId } } } } });
    found = { id: r.data.id, attributes: { ...attrs } };
    groups.push(found);
  } else if (!internal && g.publicLink !== undefined && found.attributes.publicLinkEnabled !== !!g.publicLink) {
    await write('PATCH', `/v1/betaGroups/${found.id}`, { data: { type: 'betaGroups', id: found.id, attributes: { publicLinkEnabled: !!g.publicLink } } });
  }
  return found;
}
async function addTesters(group, testers) {
  for (const t of testers || []) {
    const email = typeof t === 'string' ? t : t.email;
    try {
      const ex = await api('GET', `/v1/betaTesters?filter[email]=${encodeURIComponent(email)}`);
      if (ex.data?.length) {
        await write('POST', `/v1/betaGroups/${group.id}/relationships/betaTesters`, { data: [{ type: 'betaTesters', id: ex.data[0].id }] }, { allow: [409] });
      } else {
        await write('POST', '/v1/betaTesters', { data: { type: 'betaTesters', attributes: { email, firstName: t.firstName, lastName: t.lastName }, relationships: { betaGroups: { data: [{ type: 'betaGroups', id: group.id }] } } } });
      }
      log(`  tester ${email} -> ${group.attributes.name}`);
    } catch (e) { warn(`tester ${email}: ${e.message}`); }
  }
}
async function testflight(app) {
  const a = await findApp(app);
  const cfg = app.readJson('testflight.json', { groups: [{ name: 'Internal', internal: true, allBuilds: true, testers: [] }] });
  const locale = cfg.locale || 'en-US';
  const sinceMs = opt('since') ? Date.parse(opt('since')) - 2 * 60 * 1000 : 0;
  const groups = await list(`/v1/apps/${a.id}/betaGroups`);
  const notes = releaseNotes(app);
  log(`TestFlight: ${app.name} (${app.bundleId})\nWhat to test:\n${notes}\n`);
  for (const platform of platformsFor(app)) {
    log(`-- ${platform}`);
    const build = DRY ? await latestBuild(a.id, platform, 0) : await waitForBuild(a.id, platform, sinceMs, Number(opt('wait-minutes', '45')));
    if (!build) { warn(`no ${platform} build found`); continue; }
    // What to test
    const locs = await api('GET', `/v1/builds/${build.id}/betaBuildLocalizations`);
    const ex = (locs.data || []).find((l) => l.attributes.locale === locale);
    if (ex) await write('PATCH', `/v1/betaBuildLocalizations/${ex.id}`, { data: { type: 'betaBuildLocalizations', id: ex.id, attributes: { whatsNew: notes } } });
    else await write('POST', '/v1/betaBuildLocalizations', { data: { type: 'betaBuildLocalizations', attributes: { locale, whatsNew: notes }, relationships: { build: { data: { type: 'builds', id: build.id } } } } });
    log(`  release notes set (${locale})`);
    // Groups
    for (const g of cfg.groups || []) {
      if ((g.platforms || ['IOS', 'MAC_OS']).indexOf(platform) < 0) continue;
      const group = await ensureGroup(a.id, g, groups);
      if (g.internal === false || g.allBuilds === false) {
        await write('POST', `/v1/betaGroups/${group.id}/relationships/builds`, { data: [{ type: 'builds', id: build.id }] }, { allow: [409] });
        log(`  build ${build.attributes.version} -> ${g.name}`);
      } else log(`  ${g.name}: receives all builds automatically`);
      await addTesters(group, g.testers);
      if (g.internal === false && g.publicLink && group.attributes.publicLink) log(`  public link: ${group.attributes.publicLink}`);
    }
    // External groups need Beta App Review before testers get the build.
    if ((cfg.groups || []).some((g) => g.internal === false) && cfg.submitForBetaReview !== false) {
      const r = await write('POST', '/v1/betaAppReviewSubmissions', { data: { type: 'betaAppReviewSubmissions', relationships: { build: { data: { type: 'builds', id: build.id } } } } }, { allow: [409, 422] }).catch((e) => ({ err: e }));
      if (r?.err) warn(`beta app review submission: ${r.err.message}`);
      else if (r?.__status) log(`  beta app review: already submitted or not required (${r.__status})`);
      else log('  submitted for beta app review');
    }
  }
}

// ---------- metadata ----------
const EDITABLE = new Set(['PREPARE_FOR_SUBMISSION', 'DEVELOPER_REJECTED', 'REJECTED', 'METADATA_REJECTED', 'INVALID_BINARY']);
const pick = (o, keys) => Object.fromEntries(keys.filter((k) => !isTodo(o[k])).map((k) => [k, o[k]]));
async function upsertLocalization(kind, parentPath, parentRel, parentType, parentId, locale, attrs) {
  if (!Object.keys(attrs).length) return;
  const existing = await list(`${parentPath}`);
  const ex = existing.find((l) => l.attributes.locale === locale);
  if (ex) await write('PATCH', `/v1/${kind}/${ex.id}`, { data: { type: kind, id: ex.id, attributes: attrs } });
  else await write('POST', `/v1/${kind}`, { data: { type: kind, attributes: { locale, ...attrs }, relationships: { [parentRel]: { data: { type: parentType, id: parentId } } } } });
  log(`  ${kind} ${locale}: ${Object.keys(attrs).join(', ')}`);
}
async function metadata(app) {
  const a = await findApp(app);
  const general = app.readJson('app.json', {});
  const files = existsSync(join(app.asDir, 'metadata')) ? readdirSync(join(app.asDir, 'metadata')).filter((f) => f.endsWith('.json')) : [];
  if (!files.length) throw new Error(`No metadata files in ${join(app.asDir, 'metadata')}. Run: asc.mjs init ${positional[0]}`);
  const locales = files.map((f) => JSON.parse(readFileSync(join(app.asDir, 'metadata', f), 'utf8')));

  // App-wide info: name, subtitle, privacy policy, category
  const infos = await list(`/v1/apps/${a.id}/appInfos`);
  const info = infos.find((i) => EDITABLE.has(i.attributes.appStoreState || i.attributes.state)) || infos[0];
  if (info) {
    for (const m of locales) await upsertLocalization('appInfoLocalizations', `/v1/appInfos/${info.id}/appInfoLocalizations`, 'appInfo', 'appInfos', info.id, m.locale, pick(m, ['name', 'subtitle', 'privacyPolicyUrl']))
      .catch((e) => warn(`app info ${m.locale}: ${e.message}`));
    if (!isTodo(general.primaryCategory)) {
      const rel = { primaryCategory: { data: { type: 'appCategories', id: general.primaryCategory } } };
      if (!isTodo(general.secondaryCategory)) rel.secondaryCategory = { data: { type: 'appCategories', id: general.secondaryCategory } };
      await write('PATCH', `/v1/appInfos/${info.id}`, { data: { type: 'appInfos', id: info.id, relationships: rel } }).then(() => log(`  category ${general.primaryCategory}`)).catch((e) => warn(`category: ${e.message}`));
    }
  } else warn('no editable appInfo found; name, subtitle and category skipped');

  // Per-platform version: description, keywords, URLs, promo text, what's new
  for (const platform of platformsFor(app)) {
    log(`-- ${platform} version ${app.version}`);
    const versions = await list(`/v1/apps/${a.id}/appStoreVersions?filter[platform]=${platform}`);
    let v = versions.find((x) => x.attributes.versionString === app.version);
    if (v && !EDITABLE.has(v.attributes.appStoreState)) { warn(`${platform} ${app.version} is ${v.attributes.appStoreState}; not editable. Bump "version" in app.json.`); continue; }
    if (!v) {
      const open = versions.find((x) => EDITABLE.has(x.attributes.appStoreState));
      if (open) { v = open; warn(`using open version ${open.attributes.versionString} (app.json says ${app.version})`); }
      else {
        const r = await write('POST', '/v1/appStoreVersions', { data: { type: 'appStoreVersions', attributes: { platform, versionString: app.version }, relationships: { app: { data: { type: 'apps', id: a.id } } } } });
        v = { id: r.data.id }; log(`  created version ${app.version}`);
      }
    }
    if (!isTodo(general.copyright)) await write('PATCH', `/v1/appStoreVersions/${v.id}`, { data: { type: 'appStoreVersions', id: v.id, attributes: { copyright: general.copyright } } }).catch((e) => warn(`copyright: ${e.message}`));
    for (const m of locales) {
      const attrs = pick(m, ['description', 'keywords', 'promotionalText', 'supportUrl', 'marketingUrl', 'whatsNew']);
      await upsertLocalization('appStoreVersionLocalizations', `/v1/appStoreVersions/${v.id}/appStoreVersionLocalizations`, 'appStoreVersion', 'appStoreVersions', v.id, m.locale, attrs)
        .catch((e) => { warn(`${platform} ${m.locale}: ${e.message}`); if (attrs.whatsNew) warn('whatsNew is rejected on a first release; remove it until version 1.1'); });
    }
    const rd = general.review;
    if (rd && !isTodo(rd.contactEmail) && v.id !== 'dry-run') {
      const attrs = pick(rd, ['contactFirstName', 'contactLastName', 'contactPhone', 'contactEmail', 'demoAccountRequired', 'demoAccountName', 'demoAccountPassword', 'notes']);
      const ex = await api('GET', `/v1/appStoreVersions/${v.id}/appStoreReviewDetail`, null, { allow: [404] });
      if (ex.data?.id) await write('PATCH', `/v1/appStoreReviewDetails/${ex.data.id}`, { data: { type: 'appStoreReviewDetails', id: ex.data.id, attributes: attrs } });
      else await write('POST', '/v1/appStoreReviewDetails', { data: { type: 'appStoreReviewDetails', attributes: attrs, relationships: { appStoreVersion: { data: { type: 'appStoreVersions', id: v.id } } } } });
      log('  review details set');
    }
    if (flag('attach-build')) {
      const b = await latestBuild(a.id, platform, 0);
      if (b?.attributes.processingState === 'VALID') {
        await write('PATCH', `/v1/appStoreVersions/${v.id}/relationships/build`, { data: { type: 'builds', id: b.id } });
        log(`  attached build ${b.attributes.version}`);
      } else warn(`no processed ${platform} build to attach`);
    }
  }
}

// ---------- init / status ----------
async function init(app) {
  mkdirSync(join(app.asDir, 'metadata'), { recursive: true });
  const w = (f, o) => { const p = join(app.asDir, f); if (existsSync(p)) return log(`kept ${f}`); writeFileSync(p, typeof o === 'string' ? o : JSON.stringify(o, null, 2) + '\n'); log(`wrote ${f}`); };
  w('testflight.json', { locale: 'en-US', submitForBetaReview: true, groups: [{ name: 'Internal', internal: true, allBuilds: true, testers: [{ email: 'TODO', firstName: '', lastName: '' }] }] });
  w('release-notes.txt', 'TODO (delete this line to generate notes from git commits since the last apple-* tag)\n');
  w('app.json', { primaryCategory: 'TODO (e.g. FINANCE, FOOD_AND_DRINK)', secondaryCategory: '', copyright: 'TODO (e.g. 2026 Ryan Canfield)', review: { contactFirstName: 'TODO', contactLastName: '', contactPhone: '', contactEmail: 'TODO', demoAccountRequired: false, notes: '' } });
  let pulled = false;
  try {
    const a = await findApp(app);
    const infos = await list(`/v1/apps/${a.id}/appInfos`);
    const infoLocs = infos[0] ? await list(`/v1/appInfos/${infos[0].id}/appInfoLocalizations`) : [];
    const versions = await list(`/v1/apps/${a.id}/appStoreVersions?filter[platform]=IOS`);
    const vLocs = versions[0] ? await list(`/v1/appStoreVersions/${versions[0].id}/appStoreVersionLocalizations`) : [];
    const locales = new Set([...infoLocs, ...vLocs].map((l) => l.attributes.locale));
    for (const locale of locales) {
      const i = infoLocs.find((l) => l.attributes.locale === locale)?.attributes || {};
      const v = vLocs.find((l) => l.attributes.locale === locale)?.attributes || {};
      w(`metadata/${locale}.json`, { locale, name: i.name || 'TODO', subtitle: i.subtitle || '', privacyPolicyUrl: i.privacyPolicyUrl || 'TODO', description: v.description || 'TODO', keywords: v.keywords || 'TODO', promotionalText: v.promotionalText || '', supportUrl: v.supportUrl || 'TODO', marketingUrl: v.marketingUrl || '', whatsNew: '' });
      pulled = true;
    }
  } catch (e) { warn(`could not read App Store Connect (${e.message}); wrote templates`); }
  if (!pulled) w('metadata/en-US.json', { locale: 'en-US', name: 'TODO', subtitle: '', privacyPolicyUrl: 'TODO', description: 'TODO', keywords: 'TODO', promotionalText: '', supportUrl: 'TODO', marketingUrl: '', whatsNew: '' });
  log('Fields starting with TODO or left empty are never pushed.');
}
async function status(app) {
  const a = await findApp(app);
  log(`${app.name} ${app.bundleId} (app ${a.id})`);
  for (const platform of platformsFor(app)) {
    const b = await latestBuild(a.id, platform, 0);
    log(`  ${platform} latest build: ${b ? `${b.attributes.version} ${b.attributes.processingState} uploaded ${b.attributes.uploadedDate}` : 'none'}`);
    const vs = await list(`/v1/apps/${a.id}/appStoreVersions?filter[platform]=${platform}`);
    for (const v of vs.slice(0, 3)) log(`  ${platform} version ${v.attributes.versionString}: ${v.attributes.appStoreState}`);
  }
  for (const g of await list(`/v1/apps/${a.id}/betaGroups`)) log(`  group "${g.attributes.name}" ${g.attributes.isInternalGroup ? 'internal' : 'external'}`);
}

// ---------- main ----------
const handlers = { init, testflight, metadata, status };
if (!handlers[cmd] || !positional[0]) { console.error('Usage: asc.mjs <init|testflight|metadata|status> <app-dir> [options]'); process.exit(2); }
handlers[cmd](loadApp(positional[0])).catch((e) => { console.error(`Error: ${e.message}`); process.exit(1); });
