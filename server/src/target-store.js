import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const dataDir = process.env.DATA_DIR || path.resolve(process.cwd(), 'data');
const filePath = path.join(dataDir, 'targets.json');
let writeQueue = Promise.resolve();

async function readAll() {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw error;
  }
}

async function writeAll(targets) {
  await fs.mkdir(dataDir, { recursive: true });
  const tmp = `${filePath}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(targets, null, 2), 'utf8');
  await fs.rename(tmp, filePath);
}

function queueWrite(mutator) {
  writeQueue = writeQueue.then(async () => {
    const targets = await readAll();
    const result = await mutator(targets);
    await writeAll(targets);
    return result;
  });
  return writeQueue;
}

function normalizeViewports(viewports) {
  const input = Array.isArray(viewports) && viewports.length ? viewports : [
    { label: 'desktop', width: 1440, height: 900 },
    { label: 'tablet', width: 768, height: 1024 },
    { label: 'mobile', width: 390, height: 844 }
  ];

  return input.slice(0, 8).map((item, index) => ({
    label: String(item?.label || `viewport-${index + 1}`).slice(0, 60),
    width: Math.min(Math.max(Number(item?.width || 390), 240), 3840),
    height: Math.min(Math.max(Number(item?.height || 844), 320), 2160),
    deviceScaleFactor: Math.min(Math.max(Number(item?.deviceScaleFactor || 1), 0.5), 4),
    mobile: Boolean(item?.mobile)
  }));
}

export async function createTarget(input = {}) {
  const now = new Date().toISOString();
  const target = {
    id: crypto.randomUUID(),
    name: String(input.name || 'Untitled implementation target').slice(0, 160),
    source: input.source && typeof input.source === 'object' ? input.source : {},
    destination: input.destination && typeof input.destination === 'object' ? input.destination : {},
    viewports: normalizeViewports(input.viewports),
    status: 'draft',
    notes: String(input.notes || '').slice(0, 10000),
    createdAt: now,
    updatedAt: now,
    lastObservation: null
  };

  await queueWrite(async (targets) => {
    targets[target.id] = target;
  });

  return target;
}

export async function getTarget(id) {
  const targets = await readAll();
  return targets[id] || null;
}

export async function updateTarget(id, patch = {}) {
  return queueWrite(async (targets) => {
    const current = targets[id];
    if (!current) return null;

    const allowedStatus = new Set(['draft', 'building', 'verifying', 'repairing', 'complete', 'blocked']);
    if (patch.name !== undefined) current.name = String(patch.name).slice(0, 160);
    if (patch.source && typeof patch.source === 'object') current.source = patch.source;
    if (patch.destination && typeof patch.destination === 'object') current.destination = patch.destination;
    if (patch.viewports !== undefined) current.viewports = normalizeViewports(patch.viewports);
    if (patch.notes !== undefined) current.notes = String(patch.notes).slice(0, 10000);
    if (patch.status !== undefined && allowedStatus.has(patch.status)) current.status = patch.status;
    if (patch.lastObservation !== undefined) current.lastObservation = patch.lastObservation;
    current.updatedAt = new Date().toISOString();
    targets[id] = current;
    return current;
  });
}
