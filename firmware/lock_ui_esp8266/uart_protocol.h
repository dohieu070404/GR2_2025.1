#pragma once

#include <Arduino.h>
#include <ArduinoJson.h>

class UartProtocol {
public:
  using CommandHandler = void (*)(const char *cmd, const char *cmdId, JsonVariantConst args);

  void begin(Stream &s);
  void setCommandHandler(CommandHandler h) { _onCmd = h; }

  // call often in loop
  void tick();

  // Tx helpers
  void sendCmdResult(const char *cmdId, bool ok, const char *errorMsg = nullptr);
  void sendEvent(const char *type, JsonVariantConst data);
  void sendState(JsonVariantConst state);

private:
  void handleLine(const char *line);
  void sendJsonLine(JsonDocument &doc);

  Stream *_s = nullptr;
  CommandHandler _onCmd = nullptr;

  static constexpr size_t kMaxLine = 512;
  char _lineBuf[kMaxLine];
  size_t _lineLen = 0;
};
