#include <ESP8266WiFi.h>
#include <WiFiClientSecure.h>
#include <PubSubClient.h>
#include <ArduinoJson.h>
#include <Adafruit_Sensor.h>
#include <DHT.h>
#include <DHT_U.h>
#include <time.h>
#include "secrets.h"  // Include your WiFi and AWS credentials

// AWS IoT settings
#define AWS_IOT_PUBLISH_TOPIC "esp8266/pub"
#define AWS_IOT_SUBSCRIBE_TOPIC "esp8266/pub"

// Timezone for NTP (adjust based on your location)
#define TIME_ZONE -5

// DHT sensor settings
#define DHTPIN D2      // GPIO pin connected to the DHT sensor
#define DHTTYPE DHT22  // DHT 22 sensor

// Soil moisture sensor settings
#define SOIL_MOISTURE_PIN A0  // Analog pin for soil moisture sensor

// Motor control pin (Active-Low relay)
#define MOTOR_PIN D5  // GPIO pin connected to motor relay

DHT dht(DHTPIN, DHTTYPE);
float humidity, temperature, soilMoisture;
unsigned long lastPublish = 0;
const long publishInterval = 5000;

WiFiClientSecure net;
BearSSL::X509List cert(cacert);
BearSSL::X509List client_crt(client_cert);
BearSSL::PrivateKey key(privkey);
PubSubClient client(net);

time_t now;
time_t nowish = 1510592825;  // Default timestamp

// Function to set up NTP time
void NTPConnect() {
  Serial.print("Setting time using SNTP");
  configTime(TIME_ZONE * 3600, 0, "pool.ntp.org", "time.nist.gov");
  now = time(nullptr);
  while (now < nowish) {
    delay(500);
    Serial.print(".");
    now = time(nullptr);
  }
  Serial.println("done!");
  struct tm timeinfo;
  gmtime_r(&now, &timeinfo);
  Serial.print("Current time: ");
  Serial.print(asctime(&timeinfo));
}

unsigned long motorStartTime = 0;  // To track the motor start time
bool motorRunning = false;
int duration = 0;  // To track motor state

void messageReceived(char *topic, byte *payload, unsigned int length) {
  Serial.print("Received [");
  Serial.print(topic);
  Serial.print("]: ");
  for (int i = 0; i < length; i++) {
    Serial.print((char)payload[i]);
  }
  Serial.println();

  // Parse JSON payload for motor control
  StaticJsonDocument<200> doc;
  DeserializationError error = deserializeJson(doc, payload, length);
  if (error) {
    Serial.print("Failed to parse JSON: ");
    Serial.println(error.c_str());
    return;
  }

  const char *status = doc["status"];
  duration = doc["duration"];  // Duration in seconds

  // Check if motor status is "ON" and duration is valid
  if (status && strcmp(status, "ON") == 0 && duration > 0) {
    Serial.print("Turning motor ON for duration (seconds): ");
    Serial.println(duration);

    digitalWrite(MOTOR_PIN, LOW);  // Active-low: LOW turns motor ON
    delay(duration*1000);
    motorRunning = true;           // Set motor running state
    motorStartTime = millis();     // Record the time motor turned on
    Serial.println("Motor is ON");
  }
}

// Function to connect to AWS IoT
void connectAWS() {
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  Serial.println(String("Attempting to connect to SSID: ") + String(WIFI_SSID));

  while (WiFi.status() != WL_CONNECTED) {
    Serial.print(".");
    delay(1000);
  }

  NTPConnect();  // Sync time

  net.setTrustAnchors(&cert);
  net.setClientRSACert(&client_crt, &key);

  client.setServer(MQTT_HOST, 8883);
  client.setCallback(messageReceived);

  Serial.println("Connecting to AWS IoT...");

  while (!client.connect(THINGNAME)) {
    Serial.print(".");
    delay(1000);
  }

  if (!client.connected()) {
    Serial.println("AWS IoT Timeout!");
    return;
  }

  // Subscribe to a topic
  client.subscribe(AWS_IOT_SUBSCRIBE_TOPIC);
  Serial.println("AWS IoT Connected!");
}

// Function to publish a message to AWS IoT
void publishMessage() {
  StaticJsonDocument<200> doc;
  doc["time"] = millis();
  doc["humidity"] = humidity;
  doc["temperature"] = temperature;
  doc["soil_moisture"] = soilMoisture;

  char jsonBuffer[512];
  serializeJson(doc, jsonBuffer);

  client.publish(AWS_IOT_PUBLISH_TOPIC, jsonBuffer);
}

// Function to read soil moisture sensor
void readSoilMoisture() {
  int analogValue = analogRead(SOIL_MOISTURE_PIN);  // Read analog value from sensor
  soilMoisture = (analogValue / 1023.0) * 100.0;    // Convert to percentage (assuming 0-1023 corresponds to 0-100%)
}

// Setup function
void setup() {
  Serial.begin(115200);

  // Initialize DHT sensor
  dht.begin();
  Serial.println("DHT22 sensor initialized.");

  // Set up motor pin as output and start with the motor OFF
  pinMode(MOTOR_PIN, OUTPUT);
  digitalWrite(MOTOR_PIN, HIGH);  // Active-low: HIGH keeps motor OFF

  // Connect to AWS IoT
  connectAWS();
}

// Function to read DHT sensor with retries
bool readDHTSensor() {
  const int maxRetries = 5;  // Maximum attempts to read the sensor
  int attempts = 0;

  while (attempts < maxRetries) {
    humidity = dht.readHumidity();
    temperature = dht.readTemperature();

    if (!isnan(humidity) && !isnan(temperature)) {
      return true;  // Successfully read data
    }
      Serial.print("Humidity: ");
      Serial.print(humidity);
      Serial.print("%, Temperature: ");
      Serial.print(temperature);
      Serial.println("°C");

    attempts++;
    Serial.println("Failed to read from DHT sensor, retrying...");
    delay(2000);  // Delay between retries
  }

  Serial.println("Failed to read from DHT sensor after multiple attempts");
  return false;  // Failed to read data after max retries
}

void loop() {
  if (!client.connected()) {
    connectAWS();
  }
  client.loop();  // AWS client keep-alive

  unsigned long currentMillis = millis();
  // Check if the motor running duration has elapsed
  if (motorRunning && (currentMillis - motorStartTime >= duration * 1000)) {
    Serial.println("Duration reached, turning motor OFF.");
    digitalWrite(MOTOR_PIN, HIGH);  // Active-low: HIGH turns motor OFF
    motorRunning = false;           // Update motor state
    Serial.println("Motor is OFF after duration.");
  }

  if (currentMillis - lastPublish >= publishInterval) {
    lastPublish = currentMillis;

    // Attempt to read sensor data
    if (readDHTSensor()) {
      // Read soil moisture data
      readSoilMoisture();

      // Print sensor data
      Serial.print("Humidity: ");
      Serial.print(humidity);
      Serial.print("%  Temperature: ");
      Serial.print(temperature);
      Serial.print("°C  Soil Moisture: ");
      Serial.print(soilMoisture);
      Serial.println("%");

      // Publish message to AWS IoT
      publishMessage();
    }
  }
}
