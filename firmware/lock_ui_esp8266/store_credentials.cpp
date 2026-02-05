#include "store_credentials.h"

#include <EEPROM.h>

static constexpr uint16_t kEepromOffset = 0;

bool CredentialsStore::begin(size_t eepromSize) {
  _eepromSize = eepromSize;
  return EEPROM.begin(static_cast<int>(_eepromSize));
}

bool CredentialsStore::load() {
  EEPROM.get(kEepromOffset, _data);

  if (_data.magic != kMagic || _data.version != kVersion) {
    clearAll();
    save();
    return false;
  }

  StoreV1 tmp = _data;
  const uint32_t expected = tmp.crc32;
  tmp.crc32 = 0;
  const uint32_t actual = crc32(reinterpret_cast<const uint8_t *>(&tmp), sizeof(StoreV1));
  if (actual != expected) {
    clearAll();
    save();
    return false;
  }
  return true;
}

bool CredentialsStore::save() {
  StoreV1 tmp = _data;
  tmp.crc32 = 0;
  const uint32_t c = crc32(reinterpret_cast<const uint8_t *>(&tmp), sizeof(StoreV1));
  _data.crc32 = c;
  EEPROM.put(kEepromOffset, _data);
  return EEPROM.commit();
}

void CredentialsStore::clearAll() {
  memset(&_data, 0, sizeof(_data));
  _data.magic = kMagic;
  _data.version = kVersion;
  _data.reserved = 0;
  _data.crc32 = 0;
}

bool CredentialsStore::normalizePin(const char *in, char *out, uint8_t *outLen) {
  if (!in) return false;
  const size_t n = strlen(in);
  if (n == 0 || n > kMaxPinLen) return false;
  for (size_t i = 0; i < n; ++i) {
    if (in[i] < '0' || in[i] > '9') return false;
    out[i] = in[i];
  }
  out[n] = 0;
  *outLen = static_cast<uint8_t>(n);
  return true;
}

bool CredentialsStore::setPin(uint8_t slot, const char *pin) {
  if (!isValidSlot(slot)) return false;
  char buf[kMaxPinLen + 1];
  uint8_t len = 0;
  if (!normalizePin(pin, buf, &len)) return false;
  _data.pins[slot].valid = 1;
  _data.pins[slot].len = len;
  memset(_data.pins[slot].pin, 0, sizeof(_data.pins[slot].pin));
  memcpy(_data.pins[slot].pin, buf, len);
  return save();
}

bool CredentialsStore::deletePin(uint8_t slot) {
  if (!isValidSlot(slot)) return false;
  memset(&_data.pins[slot], 0, sizeof(PinSlot));
  return save();
}

bool CredentialsStore::setMaster(const char *pin) {
  if (!pin || strlen(pin) == 0) {
    memset(&_data.master, 0, sizeof(PinSlot));
    return save();
  }
  char buf[kMaxPinLen + 1];
  uint8_t len = 0;
  if (!normalizePin(pin, buf, &len)) return false;
  _data.master.valid = 1;
  _data.master.len = len;
  memset(_data.master.pin, 0, sizeof(_data.master.pin));
  memcpy(_data.master.pin, buf, len);
  return save();
}

bool CredentialsStore::setRfid(uint8_t slot, const uint8_t *uid, uint8_t uidLen) {
  if (!isValidSlot(slot)) return false;
  if (!uid || uidLen == 0 || uidLen > sizeof(_data.rfids[slot].uid)) return false;
  _data.rfids[slot].valid = 1;
  _data.rfids[slot].len = uidLen;
  memset(_data.rfids[slot].uid, 0, sizeof(_data.rfids[slot].uid));
  memcpy(_data.rfids[slot].uid, uid, uidLen);
  return save();
}

bool CredentialsStore::deleteRfid(uint8_t slot) {
  if (!isValidSlot(slot)) return false;
  memset(&_data.rfids[slot], 0, sizeof(RfidSlot));
  return save();
}

bool CredentialsStore::getRfid(uint8_t slot, uint8_t *uid, uint8_t *uidLen) const {
  if (!isValidSlot(slot)) return false;
  const auto &r = _data.rfids[slot];
  if (!r.valid || r.len == 0) return false;
  if (uid) memcpy(uid, r.uid, r.len);
  if (uidLen) *uidLen = r.len;
  return true;
}

bool CredentialsStore::validatePin(const char *pin, int *matchedSlot, bool *isMaster) const {
  if (matchedSlot) *matchedSlot = -1;
  if (isMaster) *isMaster = false;

  char buf[kMaxPinLen + 1];
  uint8_t len = 0;
  if (!normalizePin(pin, buf, &len)) return false;

  if (_data.master.valid && _data.master.len == len && memcmp(_data.master.pin, buf, len) == 0) {
    if (isMaster) *isMaster = true;
    return true;
  }

  for (uint8_t i = 0; i < 10; ++i) {
    const auto &p = _data.pins[i];
    if (!p.valid) continue;
    if (p.len == len && memcmp(p.pin, buf, len) == 0) {
      if (matchedSlot) *matchedSlot = i;
      return true;
    }
  }

  return false;
}

bool CredentialsStore::validateRfid(const uint8_t *uid, uint8_t uidLen, int *matchedSlot) const {
  if (matchedSlot) *matchedSlot = -1;
  if (!uid || uidLen == 0) return false;
  for (uint8_t i = 0; i < 10; ++i) {
    const auto &r = _data.rfids[i];
    if (!r.valid || r.len != uidLen) continue;
    if (memcmp(r.uid, uid, uidLen) == 0) {
      if (matchedSlot) *matchedSlot = i;
      return true;
    }
  }
  return false;
}

uint32_t CredentialsStore::crc32(const uint8_t *buf, size_t len) {
  uint32_t c = 0xFFFFFFFF;
  for (size_t i = 0; i < len; ++i) {
    c ^= buf[i];
    for (uint8_t k = 0; k < 8; ++k) {
      const uint32_t mask = -(c & 1u);
      c = (c >> 1) ^ (0xEDB88320u & mask);
    }
  }
  return ~c;
}
