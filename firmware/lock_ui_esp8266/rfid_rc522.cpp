#include "rfid_rc522.h"

#include <SPI.h>
#include <MFRC522.h>

static constexpr uint32_t kRepeatWindowMs = 1200;

bool RfidRc522::begin(uint8_t ssPin, uint8_t rstPin) {
  SPI.begin();
  // Note: MFRC522 expects RST pin to be a valid GPIO. Using a GPIO
  // (instead of tying to RST) is recommended for reliable init.
  _mfrc = new MFRC522(ssPin, rstPin);
  auto *m = reinterpret_cast<MFRC522 *>(_mfrc);
  m->PCD_Init();
  delay(20);
  return true;
}

bool RfidRc522::poll(uint8_t *uid, uint8_t *uidLen) {
  if (!_mfrc) return false;
  auto *m = reinterpret_cast<MFRC522 *>(_mfrc);
  if (!m->PICC_IsNewCardPresent()) return false;
  if (!m->PICC_ReadCardSerial()) return false;

  const uint8_t len = m->uid.size;
  if (len == 0 || len > 10) {
    m->PICC_HaltA();
    m->PCD_StopCrypto1();
    return false;
  }

  if (isRecentRepeat(m->uid.uidByte, len)) {
    m->PICC_HaltA();
    m->PCD_StopCrypto1();
    return false;
  }

  memcpy(uid, m->uid.uidByte, len);
  *uidLen = len;
  remember(uid, len);

  m->PICC_HaltA();
  m->PCD_StopCrypto1();
  return true;
}

void RfidRc522::remember(const uint8_t *uid, uint8_t uidLen) {
  _lastUidLen = uidLen;
  memcpy(_lastUid, uid, uidLen);
  _lastUidMs = millis();
}

bool RfidRc522::isRecentRepeat(const uint8_t *uid, uint8_t uidLen) const {
  if (_lastUidLen != uidLen) return false;
  if (memcmp(_lastUid, uid, uidLen) != 0) return false;
  const uint32_t now = millis();
  return (now - _lastUidMs) < kRepeatWindowMs;
}

void RfidRc522::uidToHex(const uint8_t *uid, uint8_t uidLen, char *out, size_t outLen) {
  if (!out || outLen == 0) return;
  out[0] = 0;
  size_t pos = 0;
  for (uint8_t i = 0; i < uidLen; i++) {
    if (pos + 2 >= outLen) break;
    const uint8_t b = uid[i];
    const char hex[] = "0123456789ABCDEF";
    out[pos++] = hex[(b >> 4) & 0x0F];
    out[pos++] = hex[b & 0x0F];
  }
  if (pos < outLen) out[pos] = 0;
}
