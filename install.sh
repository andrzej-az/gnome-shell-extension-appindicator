#!/bin/bash

set -e

# Configuration
BUILD_DIR="build"
PREFIX="$HOME/.local"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}Starting GNOME Shell Extension Installation...${NC}"

# Check for dependencies
if ! command -v meson &> /dev/null; then
    echo -e "${RED}Error: meson is not installed.${NC}"
    exit 1
fi

if ! command -v ninja &> /dev/null; then
    echo -e "${RED}Error: ninja is not installed.${NC}"
    exit 1
fi

# Ensure we are in the project root
if [ ! -f "meson.build" ]; then
    echo -e "${RED}Error: This script must be run from the project root.${NC}"
    exit 1
fi

# Setup/Reconfigure build directory
if [ -d "$BUILD_DIR" ]; then
    echo -e "${BLUE}Reconfiguring build directory...${NC}"
    meson setup "$BUILD_DIR" --prefix="$PREFIX" -Dlocal_install=enabled --reconfigure
else
    echo -e "${BLUE}Setting up build directory...${NC}"
    meson setup "$BUILD_DIR" --prefix="$PREFIX" -Dlocal_install=enabled
fi

# Build and Install
echo -e "${BLUE}Building and installing extension...${NC}"
ninja -C "$BUILD_DIR" install

# Extract UUID from metadata.json
UUID=$(grep -Po '"uuid":\s*"\K[^"]+' metadata.json || true)

# Reset metadata cache to prevent ghost icons from previous versions
echo -e "${BLUE}Resetting metadata cache...${NC}"
if [ -d "schemas" ]; then
    gsettings --schemadir schemas reset org.gnome.shell.extensions.appindicator icon-metadata || true
    gsettings --schemadir schemas reset org.gnome.shell.extensions.appindicator known-icons || true
fi

echo -e "${GREEN}Installation complete!${NC}"

if [ -n "$UUID" ]; then
    echo -e "Extension UUID: ${BLUE}$UUID${NC}"
    echo ""
    echo -e "To enable the extension, run:"
    echo -e "  ${GREEN}gnome-extensions enable $UUID${NC}"
    echo ""
    echo "Note: You might need to restart GNOME Shell for the changes to be fully applied."
    echo "  - X11: Press Alt+F2, type 'r', and press Enter."
    echo "  - Wayland: Log out and log back in."
else
    echo -e "${RED}Warning: Could not determine extension UUID from metadata.json.${NC}"
fi
