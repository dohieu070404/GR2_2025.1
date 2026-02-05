#pragma once

#include <Arduino.h>

// Keypad 4x4 via PCF8574 (I2C GPIO expander)
//
// PCF8574 pin mapping (recommended):
//   P0..P3 = ROW0..ROW3 (outputs)
//   P4..P7 = COL0..COL3 (inputs with pull-ups)
class Keypad4x4 {
public:
  bool begin(uint8_t i2cAddr);

  // Non-blocking: returns 0 if no new key-press event.
  char poll();

private:
  uint8_t _addr = 0;
  uint8_t _lastRaw = 0xFF;
  char _lastKey = 0;
  bool _pressedReported = false;
  uint32_t _lastScanMs = 0;
  uint32_t _lastChangeMs = 0;

  char scanMatrix();
  bool write8(uint8_t v);
  bool read8(uint8_t &v);
};
