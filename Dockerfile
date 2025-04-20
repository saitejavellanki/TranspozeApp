# Use Node.js LTS as the base image
FROM node:18-alpine

# Create app directory in the container
WORKDIR /usr/src/app

# Copy package.json and package-lock.json first to leverage Docker cache
COPY package*.json ./

# Install app dependencies
RUN npm install

# Bundle app source
COPY GoogleDriveBackend.js ./


# Create uploads directory for multer
RUN mkdir -p uploads

# Expose the port the app runs on
EXPOSE 5514

# Command to run the application
CMD ["node", "GoogleDriveBackend.js"]