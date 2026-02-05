#pragma once

#include <Arduino.h>

class RfidRc522 {
public:
  bool begin(uint8_t ssPin, uint8_t rstPin);

  // Non-blocking: returns true only when a NEW card is read (debounced).
  bool poll(uint8_t *uid, uint8_t *uidLen);

  static void uidToHex(const uint8_t *uid, uint8_t uidLen, char *out, size_t outLen);

private:
  void remember(const uint8_t *uid, uint8_t uidLen);
  bool isRecentRepeat(const uint8_t *uid, uint8_t uidLen) const;

  uint8_t _lastUid[10] = {0};
  uint8_t _lastUidLen = 0;
  uint32_t _lastUidMs = 0;

  // MFRC522 instance is allocated dynamically to allow late pin binding
  void *_mfrc = nullptr;
};
