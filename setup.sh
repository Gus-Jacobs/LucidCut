#!/bin/bash

# Video Censor Editor - Setup Script
# This script sets up the Electron app for development or production

set -e

echo "🛠️  Setting up Video Censor Editor..."

# Check Node.js
if ! command -v node &> /dev/null; then
    echo "❌ Node.js is not installed. Please install Node.js 16 or later."
    exit 1
fi

# Check Python (optional but recommended)
if ! command -v python3 &> /dev/null; then
    echo "⚠️  Python 3 is not installed. Video processing may not work."
    echo "   Install Python 3.9+ to enable video processing features."
fi

echo "✅ Node.js version: $(node --version)"
echo "✅ npm version: $(npm --version)"

# Install backend dependencies
echo ""
echo "📦 Installing backend dependencies..."
cd backend
npm install --legacy-peer-deps
cd ..

# Install frontend dependencies
echo ""
echo "📦 Installing frontend dependencies..."
cd frontend
npm install --legacy-peer-deps
cd ..

echo ""
echo "✅ Setup complete!"
echo ""
echo "🚀 To start development:"
echo "   cd frontend && npm run dev"
echo ""
echo "📦 To build for production:"
echo "   cd frontend && npm run build"
echo ""
echo "📦 To package the app:"
echo "   cd frontend && npm run package"
echo ""
