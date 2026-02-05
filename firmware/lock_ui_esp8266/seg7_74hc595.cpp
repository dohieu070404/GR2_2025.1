#include "seg7_74hc595.h"
#include "pins.h"

// Refresh period per digit (microseconds). 1500us => ~166Hz per digit (~666Hz full frame)
static constexpr uint32_t kMuxPeriodUs = 1500;

void Seg7_74HC595::begin() {
  pinMode(SEG7_DATA_PIN, OUTPUT);
  pinMode(SEG7_CLK_PIN, OUTPUT);
  pinMode(SEG7_LATCH_PIN, OUTPUT);

  // Safe idle levels
  digitalWrite(SEG7_DATA_PIN, LOW);
  digitalWrite(SEG7_CLK_PIN, LOW);
  digitalWrite(SEG7_LATCH_PIN, LOW);

  _nextUs = micros();
  setText("----");
}

void Seg7_74HC595::setText(const char *s) {
  if (!s) {
    setChars(' ', ' ', ' ', ' ');
    return;
  }
  char out[4] = {' ', ' ', ' ', ' '};
  for (int i = 0; i < 4 && s[i]; i++) out[i] = s[i];
  setChars(out[0], out[1], out[2], out[3]);
}

void Seg7_74HC595::setChars(char c0, char c1, char c2, char c3) {
  _text[0] = c0;
  _text[1] = c1;
  _text[2] = c2;
  _text[3] = c3;
}

void Seg7_74HC595::setExtraBit(uint8_t bit, bool on) {
  if (bit > 7) return;
  if (on) _extraMask |= (1u << bit);
  else _extraMask &= ~(1u << bit);
}

uint8_t Seg7_74HC595::encodeChar(char c) const {
  // Segment bits: Q0=a, Q1=b, Q2=c, Q3=d, Q4=e, Q5=f, Q6=g, Q7=dp
  // We keep dp off for now.
  switch (c) {
    case '0': return 0b00111111;
    case '1': return 0b00000110;
    case '2': return 0b01011011;
    case '3': return 0b01001111;
    case '4': return 0b01100110;
    case '5': return 0b01101101;
    case '6': return 0b01111101;
    case '7': return 0b00000111;
    case '8': return 0b01111111;
    case '9': return 0b01101111;

    case '-': return 0b01000000; // g
    case '_': return 0b00001000; // d
    case ' ': return 0b00000000;

    // Letters (best effort on 7-seg)
    case 'A':
    case 'a': return 0b01110111;
    case 'b': return 0b01111100;
    case 'C':
    case 'c': return 0b00111001;
    case 'd': return 0b01011110;
    case 'E':
    case 'e': return 0b01111001;
    case 'F':
    case 'f': return 0b01110001;
    case 'H':
    case 'h': return 0b01110100;
    case 'I':
    case 'i': return 0b00000110; // like '1'
    case 'L':
    case 'l': return 0b00111000;
    case 'N':
    case 'n': return 0b01010100;
    case 'O':
    case 'o': return 0b00111111;
    case 'P':
    case 'p': return 0b01110011;
    case 'U':
    case 'u': return 0b00111110;

    // Masked input
    case '*': return 0b01111111; // show as '8'

    default:  return 0b00000000;
  }
}

void Seg7_74HC595::shiftWrite(uint8_t segByte, uint8_t digitByte) {
  // Apply active-low options
#if SEG7_SEG_ACTIVE_LOW
  segByte = ~segByte;
#endif

  // Digit polarity only applies to the 4 digit-enable bits (Q0..Q3).
  // Extra outputs (Q4..Q7) must NOT be inverted by digit polarity.
  uint8_t digitLo = digitByte & 0x0F;
#if SEG7_DIGIT_ACTIVE_LOW
  digitLo = (~digitLo) & 0x0F;
#endif
  digitByte = digitLo | (_extraMask & 0xF0);

  digitalWrite(SEG7_LATCH_PIN, LOW);

  // ShiftReg#1 first, then ShiftReg#0
  shiftOut(SEG7_DATA_PIN, SEG7_CLK_PIN, MSBFIRST, digitByte);
  shiftOut(SEG7_DATA_PIN, SEG7_CLK_PIN, MSBFIRST, segByte);

  digitalWrite(SEG7_LATCH_PIN, HIGH);
}

void Seg7_74HC595::tick() {
  const uint32_t nowUs = micros();
  if ((int32_t)(nowUs - _nextUs) < 0) return;
  _nextUs = nowUs + kMuxPeriodUs;

  _digit = (_digit + 1) & 0x03;

  const uint8_t seg = encodeChar(_text[_digit]);

  // Digit enables on Q0..Q3 of ShiftReg#1
  uint8_t digitMask = (1u << _digit);

	// If RC522 shares the SPI pins (SCK/MOSI) with the 74HC595, make sure the RC522 is NOT selected
	// during display refresh shifting.
	digitalWrite(RC522_SS_PIN, HIGH);

  shiftWrite(seg, digitMask);
}
