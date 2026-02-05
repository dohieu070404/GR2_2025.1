#include "lock_logic.h"

#include "pins.h"
#include "rfid_rc522.h"

static constexpr uint32_t kPinInputTimeoutMs = 6000;
static constexpr uint32_t kUnlockHoldMs = 5000;
static constexpr uint8_t  kMaxFailsBeforeLockout = 5;
static constexpr uint32_t kLockoutDurationMs = 30000;

void LockLogic::begin(CredentialsStore &store, Seg7_74HC595 &display, Buzzer &buzzer, UartProtocol &uart) {
  _store = &store;
  _display = &display;
  _buzzer = &buzzer;
  _uart = &uart;

  clearPinEntry();
  setDisplayText("----");
  sendState();
}

void LockLogic::tick() {
  const uint32_t now = millis();

  // PIN entry timeout
  if (_pinLen > 0 && (int32_t)(now - _lastInputMs) > (int32_t)kPinInputTimeoutMs) {
    clearPinEntry();
    if (!isLockoutActive() && _lockState == LockState::LOCKED) {
      setDisplayText("----");
    }
  }

  // Lockout display
  if (isLockoutActive()) {
    setDisplayText("LOCK");
  }

  // Auto relock after hold time
  if (_lockState == LockState::UNLOCKED && (int32_t)(now - _unlockUntilMs) > 0) {
    _lockState = LockState::LOCKED;
    setDisplayText("----");
    sendState();
  }
}

bool LockLogic::isLockoutActive() const {
  const uint32_t now = millis();
  return _lockoutUntilMs != 0 && (int32_t)(now - _lockoutUntilMs) < 0;
}

void LockLogic::setDisplayText(const char *t) {
  if (_display) _display->setText(t);
}

void LockLogic::clearPinEntry() {
  _pinLen = 0;
  _pinBuf[0] = '\0';
}

void LockLogic::onKey(char key) {
  if (key == 0) return;

  if (isLockoutActive()) {
    // Ignore inputs during lockout
    return;
  }

  // Basic keypad behavior:
  //  - digits: append
  //  - '*': clear
  //  - '#': submit
  if (key >= '0' && key <= '9') {
    if (_pinLen < kMaxPinLen) {
      _pinBuf[_pinLen++] = key;
      _pinBuf[_pinLen] = '\0';
      _lastInputMs = millis();
      setDisplayText("****");
    }
    return;
  }

  if (key == '*') {
    clearPinEntry();
    setDisplayText("----");
    return;
  }

  if (key == '#') {
    attemptPin();
    return;
  }

  // Ignore A/B/C/D by default
}

void LockLogic::attemptPin() {
  if (_pinLen == 0) {
    return;
  }

  int slot = -1;
  bool isMaster = false;
  const bool ok = _store && _store->validatePin(_pinBuf, &slot, &isMaster);

  clearPinEntry();

  if (ok) {
    unlockSuccess("PIN", isMaster ? -1 : slot, nullptr);
  } else {
    unlockFail("PIN", nullptr);
  }
}

void LockLogic::onRfidUid(const uint8_t *uid, uint8_t uidLen) {
  if (!uid || uidLen == 0) return;
  if (isLockoutActive()) return;

  int slot = -1;
  bool ok = _store && _store->validateRfid(uid, uidLen, &slot);

  char uidHex[24] = {0};
  RfidRc522::uidToHex(uid, uidLen, uidHex, sizeof(uidHex));

  if (ok) {
    unlockSuccess("RFID", slot, uidHex);
  } else {
    unlockFail("RFID", uidHex);
  }
}

void LockLogic::unlockSuccess(const char *method, int slot, const char *uidHex) {
  _failCount = 0;
  _lockState = LockState::UNLOCKED;
  _unlockUntilMs = millis() + kUnlockHoldMs;

  strncpy(_lastMethod, method, sizeof(_lastMethod) - 1);
  _lastMethod[sizeof(_lastMethod) - 1] = '\0';
  _lastSuccess = true;
  _lastActionAtMs = millis();

  setDisplayText("OPEN");
  if (_buzzer) _buzzer->playSuccess();

  sendUnlockEvent(method, true, slot, uidHex);
  sendState();
}

void LockLogic::unlockFail(const char *method, const char *uidHex) {
  // Count failures for PIN and unknown RFID. If too many, lockout.
  _failCount++;

  strncpy(_lastMethod, method, sizeof(_lastMethod) - 1);
  _lastMethod[sizeof(_lastMethod) - 1] = '\0';
  _lastSuccess = false;
  _lastActionAtMs = millis();

  if (_failCount >= kMaxFailsBeforeLockout) {
    _failCount = 0;
    _lockoutUntilMs = millis() + kLockoutDurationMs;
    setDisplayText("LOCK");
  } else {
    setDisplayText("FAIL");
  }

  if (_buzzer) _buzzer->playFail();

  sendUnlockEvent(method, false, -1, uidHex);
  sendState();
}

void LockLogic::sendUnlockEvent(const char *method, bool success, int slot, const char *uidHex) {
  if (!_uart) return;

  StaticJsonDocument<192> data;
  data["method"] = method;
  data["success"] = success;
  if (slot >= 0) data["slot"] = slot;
  if (uidHex && uidHex[0]) data["uidHex"] = uidHex;

  _uart->sendEvent("lock.unlock", data.as<JsonVariantConst>());
}

void LockLogic::sendState() {
  if (!_uart) return;

  StaticJsonDocument<256> s;

  // Keep backward compatibility with existing mobile UI:
  //   state.lock.state and state.lastAction
  JsonObject lock = s.createNestedObject("lock");
  lock["state"] = (_lockState == LockState::LOCKED) ? "LOCKED" : "UNLOCKED";

  // New-style (optional) nested lastAction under lock as per Sprint 10 spec
  JsonObject lockLast = lock.createNestedObject("lastAction");
  lockLast["method"] = _lastMethod;
  lockLast["success"] = _lastSuccess;
  lockLast["atMs"] = _lastActionAtMs;

  if (isLockoutActive()) {
    // We don't have epoch time on ESP8266. Provide ms-until for debugging.
    uint32_t now = millis();
    uint32_t remain = (_lockoutUntilMs > now) ? (_lockoutUntilMs - now) : 0;
    lock["lockoutRemainMs"] = remain;
  }

  JsonObject door = s.createNestedObject("door");
  door["state"] = "UNKNOWN";

  JsonObject lastAction = s.createNestedObject("lastAction");
  lastAction["type"] = "unlock";
  lastAction["method"] = _lastMethod;
  lastAction["success"] = _lastSuccess;
  lastAction["atMs"] = _lastActionAtMs;

  _uart->sendState(s.as<JsonVariantConst>());
}

void LockLogic::onCommand(const char *cmd, const char *cmdId, JsonVariantConst args) {
  if (!cmd || !cmdId || !cmdId[0]) {
    return;
  }

  bool ok = false;
  const char *err = nullptr;

  if (strcmp(cmd, "lock.add_pin") == 0) {
    int slot = args["slot"] | -1;
    const char *pin = args["pin"] | "";
    if (slot < 0 || slot > 9) {
      err = "bad_slot";
    } else if (pin[0] == '\0') {
      err = "bad_pin";
    } else {
      ok = _store && _store->setPin((uint8_t)slot, pin) && _store->save();
      if (!ok) err = "store_fail";
    }
  } else if (strcmp(cmd, "lock.delete_pin") == 0) {
    int slot = args["slot"] | -1;
    if (slot < 0 || slot > 9) {
      err = "bad_slot";
    } else {
      ok = _store && _store->deletePin((uint8_t)slot) && _store->save();
      if (!ok) err = "store_fail";
    }
  } else if (strcmp(cmd, "lock.add_rfid") == 0) {
    int slot = args["slot"] | -1;
    const char *uidHex = args["uidHex"] | "";
    if (slot < 0 || slot > 9) {
      err = "bad_slot";
    } else if (uidHex[0] == '\0') {
      err = "bad_uid";
    } else {
      uint8_t uid[10] = {0};
      uint8_t uidLen = 0;
      // Parse hex string (even length)
      size_t n = strlen(uidHex);
      if (n % 2 != 0) {
        err = "bad_uid";
      } else {
        for (size_t i = 0; i < n && uidLen < sizeof(uid); i += 2) {
          char tmp[3] = {uidHex[i], uidHex[i + 1], 0};
          char *end = nullptr;
          long v = strtol(tmp, &end, 16);
          if (!end || *end != '\0' || v < 0 || v > 255) {
            uidLen = 0;
            break;
          }
          uid[uidLen++] = (uint8_t)v;
        }
        if (uidLen == 0) {
          err = "bad_uid";
        } else {
          ok = _store && _store->setRfid((uint8_t)slot, uid, uidLen) && _store->save();
          if (!ok) err = "store_fail";
        }
      }
    }
  } else if (strcmp(cmd, "lock.delete_rfid") == 0) {
    int slot = args["slot"] | -1;
    if (slot < 0 || slot > 9) {
      err = "bad_slot";
    } else {
      ok = _store && _store->deleteRfid((uint8_t)slot) && _store->save();
      if (!ok) err = "store_fail";
    }
  } else if (strcmp(cmd, "lock.set_master") == 0) {
    const char *pin = args["pin"] | "";
    ok = _store && _store->setMaster(pin) && _store->save();
    if (!ok) err = "store_fail";
  } else {
    err = "unknown_cmd";
  }

  if (_uart) _uart->sendCmdResult(cmdId, ok, err);

  // State might change (e.g., lockoutRemainMs not). Still publish updated state.
  sendState();
}
