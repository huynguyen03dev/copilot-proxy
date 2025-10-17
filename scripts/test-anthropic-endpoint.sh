#!/bin/bash

# Test script for the new Anthropic Messages endpoint
# This script tests both non-streaming and streaming requests

echo "Testing Anthropic Messages Endpoint"
echo "===================================="
echo ""

# Test 1: Non-streaming request
echo "Test 1: Non-streaming request"
echo "------------------------------"
curl -X POST http://127.0.0.1:8069/v1/messages \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-3-5-sonnet-20241022",
    "max_tokens": 100,
    "messages": [
      {"role": "user", "content": "Say hello in one sentence"}
    ]
  }'

echo ""
echo ""

# Test 2: Streaming request
echo "Test 2: Streaming request"
echo "-------------------------"
curl -X POST http://127.0.0.1:8069/v1/messages \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-3-5-sonnet-20241022",
    "max_tokens": 100,
    "stream": true,
    "messages": [
      {"role": "user", "content": "Count to 5"}
    ]
  }'

echo ""
echo ""

# Test 3: Request with system message
echo "Test 3: Request with system message"
echo "-----------------------------------"
curl -X POST http://127.0.0.1:8069/v1/messages \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-3-5-sonnet-20241022",
    "max_tokens": 50,
    "system": "You are a helpful assistant that responds concisely.",
    "messages": [
      {"role": "user", "content": "What is 2+2?"}
    ]
  }'

echo ""
echo ""
echo "===================================="
echo "Tests completed!"

