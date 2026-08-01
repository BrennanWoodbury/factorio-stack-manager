#!/bin/bash

# This script initializes the environment for the project.
which node >/dev/null 2>&1 || { echo >&2 "Node.js is required but it's not installed. Recommend using fnm or nvm. Aborting."; exit 1; }

cd backend || cd ../backend || echo "Backend directory not found. Try running directly from the scripts dir" && exit 1
npm install

cd ../frontend || echo "Frontend directory not found. Try running directly from the scripts dir" && exit 1
npm install

cd ../scripts

echo "Initialization complete. You can now run the project."