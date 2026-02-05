#pragma once

/*
  SmartLock UI (ESP8266) pin profiles

  ESP8266 boot strap pins:
    - GPIO0  (D3) must be HIGH at boot
    - GPIO2  (D4) must be HIGH at boot
    - GPIO15 (D8) must be LOW  at boot

  Notes:
    - PROFILE_A is recommended for real hardware.
    - PROFILE_B is a fallback wiring if your RC522 module pulls GPIO0 low/high in a way that
      prevents booting.

  Select the profile at compile time:
    -DLOCK_PIN_PROFILE=1  (PROFILE_A)
    -DLOCK_PIN_PROFILE=2  (PROFILE_B)

  Board: NodeMCU / Wemos D1 mini (ESP8266)
*/

#ifndef LOCK_PIN_PROFILE
#define LOCK_PIN_PROFILE 1
#endif

// ------------------ Shared config ------------------

// UART link ESP8266 <-> ESP32-C6 (newline JSON)
#define LOCK_UART_BAUD 115200

// PCF8574 keypad expander I2C
#define KEYPAD_PCF8574_ADDR 0x20
#define I2C_SDA_PIN 4   // D2
#define I2C_SCL_PIN 5   // D1

// RC522 uses HW SPI pins on ESP8266:
//   SCK  = GPIO14 (D5)
//   MISO = GPIO12 (D6)
//   MOSI = GPIO13 (D7)
//   RST  = optional (we use a GPIO in both profiles for robust init)

// 74HC595 chain length (we use 2x 74HC595 daisy-chained to save GPIO: segments + digit enables)
#define SEG7_SHIFTREG_BYTES 2

// Display electrical config
// If your display is common-anode, segments usually end up ACTIVE_LOW.
#ifndef SEG7_SEG_ACTIVE_LOW
#define SEG7_SEG_ACTIVE_LOW 1
#endif
#ifndef SEG7_DIGIT_ACTIVE_LOW
#define SEG7_DIGIT_ACTIVE_LOW 0
#endif

// ------------------ PROFILE_A (recommended) ------------------

#if LOCK_PIN_PROFILE == 1

// RC522
#define RC522_SS_PIN 0   // D3 (GPIO0)  -> MUST be HIGH at boot (add 10k pull-up if needed)
#define RC522_RST_PIN 2  // D4 (GPIO2)  -> MUST be HIGH at boot

// 74HC595 (share DATA/CLK with SPI pins to save GPIO)
#define SEG7_DATA_PIN 13  // D7 (GPIO13) MOSI
#define SEG7_CLK_PIN 14   // D5 (GPIO14) SCK
#define SEG7_LATCH_PIN 15 // D8 (GPIO15) -> MUST be LOW at boot

// Buzzer (active buzzer through transistor recommended)
#define BUZZER_USE_SHIFTREG 0
#define BUZZER_PIN 16     // D0 (GPIO16)
#define BUZZER_ACTIVE_HIGH 1

// UART uses HardwareSerial (GPIO1 TX / GPIO3 RX)
#define LOCK_UART_USE_HARDWARE 1

// ------------------ PROFILE_B (fallback) ------------------

#elif LOCK_PIN_PROFILE == 2

// RC522
#define RC522_SS_PIN 16   // D0 (GPIO16) safe (no boot strap)

// NOTE: if your module pulls GPIO0 at boot and the board fails to boot,
// moving SS from GPIO0 (PROFILE_A) to GPIO16 (PROFILE_B) usually fixes it.

#define RC522_RST_PIN 2   // D4 (GPIO2)  -> MUST be HIGH at boot

// 74HC595 (share DATA/CLK with SPI pins to save GPIO)
#define SEG7_DATA_PIN 13  // D7 (GPIO13) MOSI
#define SEG7_CLK_PIN 14   // D5 (GPIO14) SCK
#define SEG7_LATCH_PIN 15 // D8 (GPIO15) -> MUST be LOW at boot

// Buzzer driven by an extra output of the 2nd 74HC595 (saves one GPIO)
// Wire: use Q7 (bit7) of the 2nd shift register -> transistor -> buzzer
#define BUZZER_USE_SHIFTREG 1
#define BUZZER_SHIFTREG_BYTE_INDEX 1
#define BUZZER_SHIFTREG_BIT 7
#define BUZZER_ACTIVE_HIGH 1

// UART uses HardwareSerial (GPIO1 TX / GPIO3 RX)
#define LOCK_UART_USE_HARDWARE 1

#else
#error "LOCK_PIN_PROFILE must be 1 or 2"
#endif

