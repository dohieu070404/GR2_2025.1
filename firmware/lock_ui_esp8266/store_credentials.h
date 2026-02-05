#pragma once

#include <Arduino.h>

class CredentialsStore {
public:
  bool begin(size_t eepromSize = 512);
  bool load();
  bool save();

  bool setPin(uint8_t slot, const char *pin);
  bool deletePin(uint8_t slot);

  bool setRfid(uint8_t slot, const uint8_t *uid, uint8_t uidLen);
  bool deleteRfid(uint8_t slot);

  // Master PIN is optional. Pass nullptr or empty string to clear.
  bool setMaster(const char *pin);

  bool validatePin(const char *pin, int *matchedSlot, bool *isMaster) const;
  bool validateRfid(const uint8_t *uid, uint8_t uidLen, int *matchedSlot) const;

  bool getRfid(uint8_t slot, uint8_t *uid, uint8_t *uidLen) const;

  void clearAll();

private:
  static constexpr uint32_t kMagic = 0x534C4B31; // 'SLK1'
  static constexpr uint16_t kVersion = 1;
  static constexpr uint8_t kMaxPinLen = 8;

  struct PinSlot {
    uint8_t valid = 0;
    uint8_t len = 0;
    char pin[kMaxPinLen + 1] = {0};
  };

  struct RfidSlot {
    uint8_t valid = 0;
    uint8_t len = 0;
    uint8_t uid[10] = {0};
  };

  struct StoreV1 {
    uint32_t magic = kMagic;
    uint16_t version = kVersion;
    uint16_t reserved = 0;
    PinSlot pins[10];
    RfidSlot rfids[10];
    PinSlot master;
    uint32_t crc32 = 0;
  };

  StoreV1 _data;
  size_t _eepromSize = 512;

  static uint32_t crc32(const uint8_t *buf, size_t len);
  static bool isValidSlot(uint8_t slot) { return slot < 10; }
  static bool normalizePin(const char *in, char *out, uint8_t *outLen);
};
