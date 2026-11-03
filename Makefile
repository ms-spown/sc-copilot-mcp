.PHONY: install build test lint format run docker clean

# Install dependencies
install:
	npm ci --ignore-scripts

# Compile TypeScript
build:
	npm run build

# Run unit tests
test:
	npm run test

# Run ESLint
lint:
	npm run lint

# Format code with Prettier
format:
	npm run format

# Run everything needed for local development validation
verify: install format lint test build

# Start the MCP server locally
run: build
	npm start

# Build the Docker image locally
docker:
	docker build -t scmcp .

# Clean up build artifacts
clean:
	rm -rf dist node_modules
