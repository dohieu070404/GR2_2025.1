/**
 * Idempotent legacy data migration helper.
 *
 * This script is designed to help when upgrading from older schemas where
 * devices belonged directly to a user and used a user-defined MQTT topicBase.
 *
 * What it does:
 * - Ensure each user has at least one Home and a HomeMember row
 * - Ensure each device has:
 *   - deviceId (UUID string)
 *   - homeId (assigned to the owner's default home)
 *   - legacyTopicBase preserved (copied from the old topicBase column if it still exists)
 *   - legacyRoomName preserved (copied from the old room column if it still exists)
 * - Create rooms from legacyRoomName and map devices to roomId
 * - Ensure DeviceStateCurrent exists for every device
 * - Seed DeviceStateCurrent.state from old Device.lastState JSON if the column still exists
 *
 * NOTE:
 * - This is best-effort. Always backup your DB before running.
 * - If your legacy DB schema conflicts with the new schema (same table names but different columns),
 *   you may need to migrate in a staging DB first.
 */

import crypto from "crypto";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function getDbName() {
  const rows = await prisma.$queryRaw`SELECT DATABASE() AS db`;
  return rows?.[0]?.db;
}

async function tableHasColumn(tableName, columnName) {
  const db = await getDbName();
  if (!db) return false;
  const rows = await prisma.$queryRaw`
    SELECT COLUMN_NAME
    FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = ${db} AND TABLE_NAME = ${tableName} AND COLUMN_NAME = ${columnName}
    LIMIT 1
  `;
  return Array.isArray(rows) && rows.length > 0;
}

async function ensureDefaultHomes() {
  const users = await prisma.user.findMany({ select: { id: true, name: true, email: true } });
  for (const u of users) {
    let home = await prisma.home.findFirst({ where: { ownerId: u.id }, orderBy: { id: "asc" } });
    if (!home) {
      home = await prisma.home.create({
        data: {
          name: `Home of ${u.name || u.email}`,
          ownerId: u.id,
        },
      });
      console.log(`[legacy] created default home for user ${u.id} -> home ${home.id}`);
    }

    await prisma.homeMember.upsert({
      where: { homeId_userId: { homeId: home.id, userId: u.id } },
      update: { role: "OWNER" },
      create: { homeId: home.id, userId: u.id, role: "OWNER" },
    });
  }
}

async function ensureDevicesHaveHomeAndUuid() {
  // Some legacy schemas used `userId` instead of createdById.
  const hasUserId = await tableHasColumn("Device", "userId");
  const hasTopicBase = await tableHasColumn("Device", "topicBase");
  const hasRoom = await tableHasColumn("Device", "room");
  const hasLastState = await tableHasColumn("Device", "lastState");

  // Copy legacy columns into the new dedicated legacy columns (if they exist).
  if (hasTopicBase) {
    console.log("[legacy] copying Device.topicBase -> Device.legacyTopicBase");
    await prisma.$executeRawUnsafe(`
      UPDATE Device
      SET legacyTopicBase = COALESCE(legacyTopicBase, topicBase)
      WHERE (legacyTopicBase IS NULL OR legacyTopicBase = '') AND topicBase IS NOT NULL
    `);
  }

  if (hasRoom) {
    console.log("[legacy] copying Device.room -> Device.legacyRoomName");
    await prisma.$executeRawUnsafe(`
      UPDATE Device
      SET legacyRoomName = COALESCE(legacyRoomName, room)
      WHERE (legacyRoomName IS NULL OR legacyRoomName = '') AND room IS NOT NULL
    `);
  }

  // If createdById is empty but legacy userId exists, copy it.
  if (hasUserId) {
    console.log("[legacy] copying Device.userId -> Device.createdById");
    await prisma.$executeRawUnsafe(`
      UPDATE Device
      SET createdById = COALESCE(createdById, userId)
      WHERE createdById IS NULL AND userId IS NOT NULL
    `);
  }

  const devices = await prisma.device.findMany({
    select: {
      id: true,
      deviceId: true,
      homeId: true,
      createdById: true,
      legacyRoomName: true,
      roomId: true,
    },
  });

  // Build a cache of default home per user
  const defaultHomeByOwner = new Map();
  const getDefaultHomeId = async (ownerId) => {
    if (!ownerId) return null;
    if (defaultHomeByOwner.has(ownerId)) return defaultHomeByOwner.get(ownerId);
    const home = await prisma.home.findFirst({ where: { ownerId }, orderBy: { id: "asc" }, select: { id: true } });
    const hid = home?.id ?? null;
    defaultHomeByOwner.set(ownerId, hid);
    return hid;
  };

  for (const d of devices) {
    const patch = {};

    if (!d.deviceId) {
      patch.deviceId = crypto.randomUUID();
    }

    // On some partial upgrades, homeId may exist but devices were created without membership.
    // For legacy devices, we infer homeId from createdById (owner).
    if (!d.homeId) {
      const ownerId = d.createdById;
      const homeId = await getDefaultHomeId(ownerId);
      if (homeId) patch.homeId = homeId;
    }

    if (Object.keys(patch).length > 0) {
      await prisma.device.update({ where: { id: d.id }, data: patch });
      console.log(`[legacy] patched Device ${d.id}:`, patch);
    }
  }

  // Create rooms from legacyRoomName, map devices to roomId
  const devicesForRooms = await prisma.device.findMany({
    select: { id: true, homeId: true, roomId: true, legacyRoomName: true },
  });

  // Cache rooms by (homeId,name)
  const roomCache = new Map();
  const getRoomId = async (homeId, name) => {
    const key = `${homeId}:${name}`;
    if (roomCache.has(key)) return roomCache.get(key);
    const room = await prisma.room.upsert({
      where: { homeId_name: { homeId, name } },
      update: {},
      create: { homeId, name },
      select: { id: true },
    });
    roomCache.set(key, room.id);
    return room.id;
  };

  for (const d of devicesForRooms) {
    if (d.roomId) continue;
    if (!d.legacyRoomName) continue;
    const name = String(d.legacyRoomName).trim();
    if (!name) continue;
    const rid = await getRoomId(d.homeId, name);
    await prisma.device.update({ where: { id: d.id }, data: { roomId: rid } });
  }

  // Ensure DeviceStateCurrent exists for each device
  const allDevices = await prisma.device.findMany({ select: { id: true } });
  for (const d of allDevices) {
    await prisma.deviceStateCurrent.upsert({
      where: { deviceId: d.id },
      update: {},
      create: { deviceId: d.id, state: null, online: false },
    });
  }

  // Seed stateCurrent.state from Device.lastState if still present
  if (hasLastState) {
    console.log("[legacy] seeding DeviceStateCurrent.state from Device.lastState where empty");
    await prisma.$executeRawUnsafe(`
      UPDATE DeviceStateCurrent dsc
      JOIN Device d ON d.id = dsc.deviceId
      SET dsc.state = d.lastState
      WHERE dsc.state IS NULL AND d.lastState IS NOT NULL
    `);
  }
}

async function main() {
  console.log("[legacy] starting legacy data migration helper...");
  await ensureDefaultHomes();
  await ensureDevicesHaveHomeAndUuid();
  console.log("[legacy] done");
}

main()
  .catch((e) => {
    console.error("[legacy] failed:", e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
