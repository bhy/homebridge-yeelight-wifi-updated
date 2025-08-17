# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a Homebridge plugin for YeeLight Wi-Fi bulbs and lamps. It's a Node.js project that implements the Yeelight WiFi Light Inter-Operation Specification to control smart lights through Apple HomeKit.

## Common Development Commands

```bash
# Start development server with debug logging
npm start
# or
yarn start

# Format code
npm run format

# Lint code (ESLint configuration included in package.json)
npx eslint **/*.js --fix

# Format and lint together (runs automatically after tests)
npm run posttest
```

## Architecture

### Core Components

- **index.js**: Entry point that registers the platform with Homebridge
- **platform.js**: Main platform class (`YeePlatform`) that handles device discovery via UDP multicast, manages accessories, and builds device instances
- **utils.js**: Shared utilities including device ID parsing, configuration helpers, sleep function, and color temperature conversion lookup table

### Device Architecture (Mixin Pattern)

The plugin uses a sophisticated mixin pattern to compose device capabilities:

- **bulbs/bulb.js**: Base `YeeBulb` class with core functionality (power control, TCP communication, command queuing with exponential backoff)
- **Capability Mixins**: Each capability is a separate mixin that can be composed:
  - `bulbs/brightness.js`: Brightness control
  - `bulbs/color.js`: HSV color control
  - `bulbs/temperature.js`: Color temperature control
  - `bulbs/moonlight.js`: Moonlight mode
  - `bulbs/backlight/`: Backlight variants (bulb, brightness, color)

Device instances are created by dynamically composing mixins based on device capabilities advertised during discovery.

### Device Discovery & Communication

- Uses UDP multicast (239.255.255.250:1982) for device discovery
- Implements SSDP-like protocol for YeeLight device advertisement
- TCP communication for device control with retry logic and exponential backoff
- Persistent device tracking with automatic reconnection

### Configuration

- **devices.json**: Device-specific configurations (color temperature ranges per model)
- **homebridge/config.json**: Development configuration for local testing
- Platform configuration supports transitions, connection settings, multicast interface, and per-device customization

## Development Workflow

1. Use `npm start` to run a local Homebridge instance in debug mode
2. Add the bridge in Home.app (+ Add Accessory) as "Yeelight Platform Development"
3. Enable Developer Mode on YeeLight devices for API access
4. Remove bridge from Home.app when done: Home → 🏠 → Hubs & Bridges

## Key Implementation Details

- Device IDs are derived from the last 6 characters of the full device ID
- Commands use incremental IDs and JSON-RPC over TCP
- Color temperature conversion uses a comprehensive mired-to-HSV lookup table
- Supports blacklisting specific device capabilities or entire devices
- Implements robust error handling with command queuing and retry mechanisms
