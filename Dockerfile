# Use an official Node.js runtime as a parent image (choose a version compatible with your dependencies)
    # Using LTS (Long Term Support) version is generally recommended for stability
    FROM node:20-alpine AS base

    # Set the working directory in the container
    WORKDIR /usr/src/app

    # Copy package.json and package-lock.json (or yarn.lock or pnpm-lock.yaml)
    COPY package*.json ./

    # --- Build Stage ---
    # Install all dependencies, including devDependencies needed for build
    FROM base AS build
    RUN npm ci
    # Copy the rest of the application source code
    COPY . .
    # Compile TypeScript to JavaScript
    RUN npm run build

    # --- Production Stage ---
    # Start from a clean base image again
    FROM base AS production
    # Copy only necessary files from the build stage
    COPY package*.json ./
    # Install *only* production dependencies
    RUN npm ci --only=production
    # Copy the compiled JavaScript code from the build stage
    COPY --from=build /usr/src/app/dist ./dist
    # Copy the context7 lib files needed at runtime by the compiled code
    COPY --from=build /usr/src/app/context7/src/lib ./context7/src/lib

    # Expose the port the app runs on
    EXPOSE 3000

    # Define the command to run the application
    # Use the "start" script defined in package.json which runs the compiled JS
    CMD [ "npm", "start" ]
