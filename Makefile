SHELL := /bin/bash

.DEFAULT_GOAL := help

ROOT_DIR := $(CURDIR)
RELEASE_DIR := $(ROOT_DIR)/release
MOBILE_DIR := $(ROOT_DIR)/apps/mobile
DESKTOP_DIR := $(ROOT_DIR)/apps/desktop
ANDROID_RELEASE_DIR := $(RELEASE_DIR)/android
IOS_RELEASE_DIR := $(RELEASE_DIR)/ios
MACOS_RELEASE_DIR := $(RELEASE_DIR)/macos
WINDOWS_RELEASE_DIR := $(RELEASE_DIR)/windows
IOS_CODESIGN ?= false
IOS_EXPORT_OPTIONS_PLIST ?=
TAURI_WINDOWS_TARGET ?= x86_64-pc-windows-msvc
ANDROID_JAVA_HOME ?= $(shell if [[ -d /opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home ]]; then echo /opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home; fi)
ANDROID_ENV := $(if $(ANDROID_JAVA_HOME),JAVA_HOME="$(ANDROID_JAVA_HOME)" PATH="$(ANDROID_JAVA_HOME)/bin:$$PATH",)

.PHONY: help dev stop package package-android package-ios package-macos package-windows prepare-release-dir

help:
	@echo "FnzSafe commands"
	@echo "  make dev              Start the desktop dev app; old local dev processes are stopped first"
	@echo "  make stop             Stop all local FnzSafe development processes"
	@echo "  make package          Build Android, iOS, macOS, and Windows packages into ./release"
	@echo "  make package-android  Build Android APK/AAB into ./release/android"
	@echo "  make package-ios      Build iOS app/IPA into ./release/ios"
	@echo "  make package-macos    Build the macOS desktop package into ./release/macos"
	@echo "  make package-windows  Build the Windows desktop package into ./release/windows"
	@echo ""
	@echo "Options:"
	@echo "  ANDROID_JAVA_HOME=/path/to/jdk17 make package-android"
	@echo "  IOS_CODESIGN=true IOS_EXPORT_OPTIONS_PLIST=/path/ExportOptions.plist make package-ios"
	@echo "  APPLE_SIGNING_IDENTITY='Developer ID Application: ...' make package-macos"
	@echo "  TAURI_WINDOWS_TARGET=x86_64-pc-windows-msvc make package-windows"

dev:
	cd apps/desktop && npm run desktop:dev

stop:
	cd "$(DESKTOP_DIR)" && npm run stop

package: package-android package-ios package-macos package-windows

prepare-release-dir:
	mkdir -p "$(RELEASE_DIR)"

package-android: prepare-release-dir
	mkdir -p "$(ANDROID_RELEASE_DIR)"
	cd "$(MOBILE_DIR)" && ./tool/build_android_native.sh
	cd "$(MOBILE_DIR)" && $(ANDROID_ENV) flutter build apk --release
	cd "$(MOBILE_DIR)" && $(ANDROID_ENV) flutter build appbundle
	@copied=0; \
	for artifact in \
		"$(MOBILE_DIR)/build/app/outputs/flutter-apk/app-release.apk" \
		"$(MOBILE_DIR)/build/app/outputs/bundle/release/app-release.aab"; do \
		if [[ -f "$$artifact" ]]; then \
			cp -f "$$artifact" "$(ANDROID_RELEASE_DIR)/"; \
			echo "Copied $$artifact -> $(ANDROID_RELEASE_DIR)/"; \
			copied=1; \
		fi; \
	done; \
	if [[ "$$copied" != "1" ]]; then \
		echo "No Android package artifacts were found." >&2; \
		exit 1; \
	fi

package-ios: prepare-release-dir
	mkdir -p "$(IOS_RELEASE_DIR)"
	cd "$(MOBILE_DIR)" && ./tool/build_ios_native.sh
	@if [[ "$(IOS_CODESIGN)" == "true" ]]; then \
		if [[ -n "$(IOS_EXPORT_OPTIONS_PLIST)" ]]; then \
			cd "$(MOBILE_DIR)" && flutter build ipa --release --export-options-plist "$(IOS_EXPORT_OPTIONS_PLIST)"; \
		else \
			cd "$(MOBILE_DIR)" && flutter build ipa --release; \
		fi; \
	else \
		cd "$(MOBILE_DIR)" && flutter build ios --release --no-codesign; \
	fi
	@copied=0; \
	while IFS= read -r artifact; do \
		cp -R "$$artifact" "$(IOS_RELEASE_DIR)/"; \
		echo "Copied $$artifact -> $(IOS_RELEASE_DIR)/"; \
		copied=1; \
	done < <(find "$(MOBILE_DIR)/build/ios" -maxdepth 5 \( -name "*.ipa" -o -name "*.app" \) -print 2>/dev/null); \
	if [[ "$$copied" != "1" ]]; then \
		echo "No iOS package artifacts were found." >&2; \
		exit 1; \
	fi

package-macos:
	mkdir -p "$(MACOS_RELEASE_DIR)"
	cd "$(DESKTOP_DIR)" && node scripts/macos-release.cjs preflight
	cd "$(DESKTOP_DIR)" && npm run desktop:build
	@copied=0; \
	while IFS= read -r artifact; do \
		cp -R "$$artifact" "$(MACOS_RELEASE_DIR)/"; \
		echo "Copied $$artifact -> $(MACOS_RELEASE_DIR)/"; \
		copied=1; \
	done < <(find \
		"$(DESKTOP_DIR)/src-tauri/target/release/bundle" \
		"$(ROOT_DIR)/build-cache/release/bundle" \
		-maxdepth 5 \( -name "FnzSafe_*.dmg" -o -name "FnzSafe.app" \) ! -name "rw.*" -print 2>/dev/null); \
	if [[ "$$copied" != "1" ]]; then \
		echo "No macOS desktop package artifacts were found." >&2; \
		exit 1; \
	fi
	cd "$(DESKTOP_DIR)" && node scripts/macos-release.cjs verify "$(MACOS_RELEASE_DIR)"

package-windows:
	mkdir -p "$(WINDOWS_RELEASE_DIR)"
	cd "$(DESKTOP_DIR)" && npm run tauri -- build --target "$(TAURI_WINDOWS_TARGET)"
	@copied=0; \
	while IFS= read -r artifact; do \
		cp -f "$$artifact" "$(WINDOWS_RELEASE_DIR)/"; \
		echo "Copied $$artifact -> $(WINDOWS_RELEASE_DIR)/"; \
		copied=1; \
	done < <(find \
		"$(DESKTOP_DIR)/src-tauri/target/$(TAURI_WINDOWS_TARGET)/release/bundle" \
		"$(ROOT_DIR)/build-cache/$(TAURI_WINDOWS_TARGET)/release/bundle" \
		-maxdepth 6 \( -name "*.msi" -o -name "*.exe" \) -print 2>/dev/null); \
	if [[ "$$copied" != "1" ]]; then \
		echo "No Windows desktop package artifacts were found." >&2; \
		exit 1; \
	fi
