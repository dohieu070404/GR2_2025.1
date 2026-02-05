#include "keypad_4x4.h"

#include <Wire.h>

// Key map
static const char kMap[4][4] = {
    {'1', '2', '3', 'A'},
    {'4', '5', '6', 'B'},
    {'7', '8', '9', 'C'},
    {'*', '0', '#', 'D'},
};

static bool pcfWrite(uint8_t addr, uint8_t value) {
  Wire.beginTransmission(addr);
  Wire.write(value);
  return Wire.endTransmission() == 0;
}

static bool pcfRead(uint8_t addr, uint8_t *out) {
  if (Wire.requestFrom((int)addr, 1) != 1) return false;
  if (!Wire.available()) return false;
  *out = (uint8_t)Wire.read();
  return true;
}

bool Keypad4x4::begin(uint8_t i2cAddr) {
  _addr = i2cAddr;
  // Initial state: all pins HIGH (rows released + cols inputs)
  return pcfWrite(_addr, 0xFF);
}

char Keypad4x4::poll() {
  const uint32_t now = millis();
  if ((int32_t)(now - _nextScanMs) < 0) return 0;
  _nextScanMs = now + 20;  // scan every 20ms

  const char raw = scanRaw();

  if (raw != _lastKey) {
    _lastKey = raw;
    _stableSinceMs = now;
    _reported = false;
    return 0;
  }

  if (raw == 0) {
    _reported = false;
    return 0;
  }

  if (!_reported && (now - _stableSinceMs) >= 40) {
    _reported = true;
    return raw;
  }

  return 0;
}

char Keypad4x4::scanRaw() {
  // Columns are P4..P7 (bit=1 idle due to pull-up), pressed -> 0.
  // Rows are P0..P3: we drive one LOW at a time.

  for (uint8_t row = 0; row < 4; row++) {
    uint8_t out = 0xFF;
    out &= ~(1u << row);  // drive this row LOW
    if (!pcfWrite(_addr, out)) {
      // If bus error, return no-key
      pcfWrite(_addr, 0xFF);
      return 0;
    }

    delayMicroseconds(80);

    uint8_t in = 0xFF;
    if (!pcfRead(_addr, &in)) {
      pcfWrite(_addr, 0xFF);
      return 0;
    }

    // Check columns
    for (uint8_t col = 0; col < 4; col++) {
      const uint8_t bit = 4 + col;
      if (((in >> bit) & 0x01) == 0) {
        pcfWrite(_addr, 0xFF);
        return kMap[row][col];
      }
    }
  }

  pcfWrite(_addr, 0xFF);
  return 0;
}
