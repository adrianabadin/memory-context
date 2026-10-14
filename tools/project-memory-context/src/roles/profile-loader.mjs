// Explicit project profile loading; classification itself performs no project I/O.
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { loadProfile, mergeProfiles, assertProfile } from './classify.mjs';

const tables = {
  suffixRoles: 'suffix', directoryRoles: 'token', annotationRoles: 'annotation',
  sideEffectRoles: 'marker', heritageTypeRoles: 'name', topologyRules: 'when',
};
const weightNames = Object.keys(loadProfile('generic').weights);
const allowed = new Set([
  'extends', 'name', 'description', 'roleLayers', 'weights', 'topologyThresholds',
  'decoratorFactoryNames', ...Object.keys(tables),
]);

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value;
}

function nonempty(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${label} must be a nonempty string`);
}

function validateOverride(config) {
  object(config, 'roles.json');
  for (const key of Object.keys(config)) {
    if (!allowed.has(key)) throw new TypeError(`Unknown roles.json field: ${key}`);
  }
  for (const key of ['extends', 'name', 'description']) {
    if (Object.hasOwn(config, key)) nonempty(config[key], key);
  }
  if (Object.hasOwn(config, 'roleLayers')) {
    for (const [role, layer] of Object.entries(object(config.roleLayers, 'roleLayers'))) {
      nonempty(role, 'role');
      nonempty(layer, `roleLayers.${role}`);
      if (['__proto__', 'constructor', 'prototype'].includes(role)) throw new TypeError('Reserved role name');
    }
  }
  if (Object.hasOwn(config, 'weights')) {
    for (const [key, value] of Object.entries(object(config.weights, 'weights'))) {
      if (!weightNames.includes(key) || !Number.isFinite(value) || value < 0 || value > 1) {
        throw new TypeError(`Invalid roles.json weight: ${key}`);
      }
    }
  }
  if (Object.hasOwn(config, 'topologyThresholds')) {
    for (const [key, value] of Object.entries(object(config.topologyThresholds, 'topologyThresholds'))) {
      if (!['fanIn', 'fanOut', 'lowFanIn'].includes(key) || !Number.isFinite(value) || value < 0) {
        throw new TypeError(`Invalid topology threshold: ${key}`);
      }
    }
  }
  if (Object.hasOwn(config, 'decoratorFactoryNames')) {
    if (!Array.isArray(config.decoratorFactoryNames)) throw new TypeError('decoratorFactoryNames must be an array');
    for (const name of config.decoratorFactoryNames) nonempty(name, 'decorator factory name');
  }
  for (const [table, key] of Object.entries(tables)) {
    if (!Object.hasOwn(config, table)) continue;
    if (!Array.isArray(config[table])) throw new TypeError(`${table} must be an array`);
    for (const entry of config[table]) {
      object(entry, table);
      if (Object.keys(entry).some((field) => field !== key && field !== 'role')) throw new TypeError(`Unknown ${table} field`);
      nonempty(entry[key], `${table}.${key}`);
      nonempty(entry.role, `${table}.role`);
      if (table === 'topologyRules' && !['highFanOutLowFanIn', 'highFanIn'].includes(entry.when)) {
        throw new TypeError(`Unsupported topology rule: ${entry.when}`);
      }
    }
  }
}

export async function loadProjectProfile(projectRoot, options = {}) {
  nonempty(projectRoot, 'projectRoot');
  object(options, 'profile options');
  for (const key of Object.keys(options)) {
    if (key !== 'profileName') throw new TypeError(`Unknown profile option: ${key}`);
  }
  const { profileName = 'generic' } = options;
  const fallback = loadProfile(profileName);
  let raw;
  try {
    raw = await readFile(resolve(projectRoot, '.planning/project-memory-context/roles.json'), 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
  const config = JSON.parse(raw);
  validateOverride(config);
  const { extends: baseName = profileName, ...overrides } = config;
  const profile = mergeProfiles(loadProfile(baseName), overrides);
  assertProfile(profile);
  return profile;
}
