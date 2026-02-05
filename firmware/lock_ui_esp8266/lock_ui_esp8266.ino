/*
  SmartLock UI firmware (ESP8266)

  Features (Sprint 10):
    - Offline PIN/RFID unlock with anti brute-force lockout
    - 4-digit 7-seg display via 2x 74HC595 (multiplex)
    - 4x4 keypad via PCF8574 (I2C) to save GPIO
    - RC522 RFID over SPI
    - UART newline JSON to ESP32-C6 Zigbee bridge (cmdId end-to-end)

  Build notes:
    - Requires libraries: ArduinoJson, MFRC522, ESP8266 EEPROM
    - Select pin profile by defining LOCK_PIN_PROFILE (1 = PROFILE_A, 2 = PROFILE_B)
*/

#include <Arduino.h>
#include <Wire.h>

#include "pins.h"
#include "seg7_74hc595.h"
#include "buzzer.h"
#include "keypad_4x4.h"
#include "rfid_rc522.h"
#include "store_credentials.h"
#include "uart_protocol.h"
#include "lock_logic.h"

static Seg7_74HC595 gDisplay;
static Buzzer gBuzzer;
static Keypad4x4 gKeypad;
static RfidRc522 gRfid;
static CredentialsStore gStore;
static UartProtocol gUart;
static LockLogic gLogic;

#if BUZZER_USE_SHIFTREG
static void buzzerShiftHook(bool on) {
  gDisplay.setExtraBit(BUZZER_SHIFTREG_BYTE, BUZZER_SHIFTREG_BIT, on);
}
#endif

static void onUartCommand(const char *cmd, const char *cmdId, JsonVariantConst args) {
  gLogic.onCommand(cmd, cmdId, args);
}

void setup() {
  // UART to ESP32-C6 bridge uses Serial (GPIO1/3)
  Serial.begin(LOCK_UART_BAUD);
  Serial.setTimeout(0);

  Wire.begin(I2C_SDA_PIN, I2C_SCL_PIN);

  gDisplay.begin();
  gBuzzer.begin();
#if BUZZER_USE_SHIFTREG
  gBuzzer.setShiftRegHook(buzzerShiftHook);
#endif

  gStore.begin(512);
  gStore.load();

  gKeypad.begin(PCF8574_ADDR);

  gRfid.begin(RC522_SS_PIN, RC522_RST_PIN);

  gUart.begin(Serial);
  gUart.setCommandHandler(onUartCommand);

  gLogic.begin(gStore, gDisplay, gBuzzer, gUart);
}

void loop() {
  gDisplay.tick();
  gBuzzer.tick();
  gUart.tick();

  const char key = gKeypad.poll();
  if (key) {
    gLogic.onKey(key);
  }

  uint8_t uid[10] = {0};
  uint8_t uidLen = 0;
  if (gRfid.poll(uid, &uidLen)) {
    gLogic.onRfidUid(uid, uidLen);
  }

  gLogic.tick();
}
