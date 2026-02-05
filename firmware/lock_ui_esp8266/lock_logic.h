#pragma once

#include <Arduino.h>
#include <ArduinoJson.h>

#include "buzzer.h"
#include "seg7_74hc595.h"
#include "store_credentials.h"
#include "uart_protocol.h"

class LockLogic {
public:
  void begin(CredentialsStore &store, Seg7_74HC595 &display, Buzzer &buzzer, UartProtocol &uart);

  void tick();

  // Inputs
  void onKey(char key);
  void onRfidUid(const uint8_t *uid, uint8_t uidLen);

  // UART remote management commands
  void onCommand(const char *cmd, const char *cmdId, JsonVariantConst args);

private:
  enum class LockState : uint8_t { LOCKED, UNLOCKED };

  void setDisplayText(const char *t);
  void clearPinEntry();

  void attemptPin();
  void unlockSuccess(const char *method, int slot, const char *uidHex);
  void unlockFail(const char *method, const char *uidHex);

  void sendUnlockEvent(const char *method, bool success, int slot, const char *uidHex);
  void sendState();

  bool isLockoutActive() const;

  CredentialsStore *_store = nullptr;
  Seg7_74HC595 *_display = nullptr;
  Buzzer *_buzzer = nullptr;
  UartProtocol *_uart = nullptr;

  LockState _lockState = LockState::LOCKED;
  uint32_t _unlockUntilMs = 0;

  // PIN entry
  static constexpr uint8_t kMaxPinLen = 8;
  char _pinBuf[kMaxPinLen + 1] = {0};
  uint8_t _pinLen = 0;
  uint32_t _lastInputMs = 0;

  // Brute force
  uint8_t _failCount = 0;
  uint32_t _lockoutUntilMs = 0;

  // Last action (for state)
  char _lastMethod[8] = ""; // "PIN" or "RFID"
  bool _lastSuccess = false;
  uint32_t _lastActionAtMs = 0;
};
