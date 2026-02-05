#include "uart_protocol.h"

void UartProtocol::begin(Stream &s) {
  _s = &s;
  _lineLen = 0;
}

void UartProtocol::tick() {
  if (!_s) return;
  while (_s->available()) {
    const int c = _s->read();
    if (c < 0) break;

    if (c == '\r') continue;

    if (c == '\n') {
      if (_lineLen > 0) {
        _lineBuf[_lineLen] = '\0';
        handleLine(_lineBuf);
      }
      _lineLen = 0;
      continue;
    }

    if (_lineLen < kMaxLine - 1) {
      _lineBuf[_lineLen++] = (char)c;
    } else {
      // overflow -> drop
      _lineLen = 0;
    }
  }
}

void UartProtocol::handleLine(const char *line) {
  StaticJsonDocument<512> doc;
  DeserializationError err = deserializeJson(doc, line);
  if (err) {
    // Ignore non-JSON / boot logs.
    return;
  }

  const char *cmd = doc["cmd"] | nullptr;
  if (!cmd) return;

  const char *cmdId = doc["cmdId"] | "";
  JsonVariantConst args = doc["args"].isNull() ? doc["params"] : doc["args"];
  if (_onCmd) {
    _onCmd(cmd, cmdId, args);
  }
}

void UartProtocol::sendJsonLine(JsonDocument &doc) {
  if (!_s) return;
  serializeJson(doc, *_s);
  _s->print('\n');
}

void UartProtocol::sendCmdResult(const char *cmdId, bool ok, const char *errorMsg) {
  StaticJsonDocument<256> doc;
  doc["evt"] = "cmd_result";
  doc["cmdId"] = cmdId ? cmdId : "";
  doc["ok"] = ok;
  if (!ok && errorMsg && errorMsg[0] != '\0') {
    doc["error"] = errorMsg;
  }
  sendJsonLine(doc);
}

void UartProtocol::sendEvent(const char *type, JsonVariantConst data) {
  StaticJsonDocument<384> doc;
  doc["evt"] = "event";
  doc["type"] = type;
  if (!data.isNull()) {
    doc["data"] = data;
  }
  sendJsonLine(doc);
}

void UartProtocol::sendState(JsonVariantConst state) {
  StaticJsonDocument<384> doc;
  doc["evt"] = "state";
  doc["state"] = state;
  sendJsonLine(doc);
}
