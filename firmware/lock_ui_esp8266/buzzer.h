#pragma once

#include <Arduino.h>

// Non-blocking buzzer patterns (success/fail).
class Buzzer {
public:
  void begin();

  // call often (every loop)
  void tick();

  void playSuccess();
  void playFail();
  void stop();

  // For SEG7 shift-register buzzer mode (PROFILE_B), allow a hook that
  // will be called whenever buzzer output changes.
  void setShiftRegHook(void (*hook)(bool level));

private:
  void startPattern(const uint16_t *durationsMs, uint8_t count);
  void setOutput(bool on);

  void (*_shiftHook)(bool) = nullptr;

  bool _on = false;
  bool _active = false;
  uint8_t _idx = 0;
  uint8_t _count = 0;
  uint32_t _nextMs = 0;
  const uint16_t *_durationsMs = nullptr;
};
