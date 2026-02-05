#include "buzzer.h"
#include "pins.h"

// Patterns are alternating ON/OFF durations.
static constexpr uint16_t kSuccessPatternMs[] = {150, 80};
static constexpr uint16_t kFailPatternMs[] = {80, 70, 80, 70, 80, 70};

void Buzzer::begin() {
#if !BUZZER_USE_SHIFTREG
  pinMode(BUZZER_PIN, OUTPUT);
  digitalWrite(BUZZER_PIN, BUZZER_ACTIVE_HIGH ? LOW : HIGH);
#endif
  _active = false;
  _on = false;
}

void Buzzer::setShiftRegHook(void (*hook)(bool)) {
  _shiftHook = hook;
}

void Buzzer::setOutput(bool on) {
  _on = on;
#if BUZZER_USE_SHIFTREG
  if (_shiftHook) {
    // In shift-reg mode we assume 'level==true' means buzzer active.
    _shiftHook(on);
  }
#else
  digitalWrite(BUZZER_PIN, (on == BUZZER_ACTIVE_HIGH) ? HIGH : LOW);
#endif
}

void Buzzer::startPattern(const uint16_t *durationsMs, uint8_t count) {
  _durationsMs = durationsMs;
  _count = count;
  _idx = 0;
  _active = true;
  setOutput(true);
  // First toggle happens after durationsMs[0]
  _nextMs = millis() + _durationsMs[0];
}

void Buzzer::playSuccess() {
  startPattern(kSuccessPatternMs, sizeof(kSuccessPatternMs) / sizeof(kSuccessPatternMs[0]));
}

void Buzzer::playFail() {
  startPattern(kFailPatternMs, sizeof(kFailPatternMs) / sizeof(kFailPatternMs[0]));
}

void Buzzer::stop() {
  _active = false;
  setOutput(false);
}

void Buzzer::tick() {
  if (!_active) return;
  const uint32_t now = millis();
  if ((int32_t)(now - _nextMs) < 0) return;

  // Move to next duration/state
  _idx++;
  if (_idx >= _count) {
    _active = false;
    setOutput(false);
    return;
  }

  // Toggle for the next state and arm next change
  setOutput(!_on);
  _nextMs = now + _durationsMs[_idx];
}
