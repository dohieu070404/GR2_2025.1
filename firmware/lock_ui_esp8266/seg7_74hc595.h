#pragma once

#include <Arduino.h>

// 4-digit 7-seg multiplex driven by 2x 74HC595 daisy-chained.
//   - ShiftReg#0 (closest to MCU) drives segments a..g + dp (8 bits)
//   - ShiftReg#1 drives digit enables (lower 4 bits) + optional extras (upper bits)
//
// Wiring expectation:
//   MCU DATA -> DS of ShiftReg#0
//   ShiftReg#0 Q7' -> DS of ShiftReg#1
//   Both share CLK and LATCH.
//
// Shift order in code: send byte[1] first, then byte[0] so that byte[0] lands in ShiftReg#0.

class Seg7_74HC595 {
 public:
  void begin();

  // Set a 4-char text (padded/truncated to 4)
  void setText(const char *s);
  void setChars(char c0, char c1, char c2, char c3);

  // Multiplex tick: call as often as possible from loop()
  void tick();

  // Optional: control extra outputs on ShiftReg#1 (byte index 1)
  void setExtraBit(uint8_t bit, bool on);

 private:
  uint8_t encodeChar(char c) const;
  void shiftWrite(uint8_t segByte, uint8_t digitByte);

  char _text[4] = {' ', ' ', ' ', ' '};
  uint8_t _digit = 0;
  uint32_t _nextUs = 0;
  uint8_t _extraMask = 0;
};
