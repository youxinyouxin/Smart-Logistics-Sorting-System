# sorter —— 传送带快递自动分拣（C++17）
# 依赖：OpenCV4（/usr/include/opencv4）、libcurl、nlohmann/json、lgpio、pthread

CXX      ?= g++
CC       ?= gcc
CXXFLAGS ?= -O2 -std=c++17 -pthread
CPPFLAGS += -I/usr/include/opencv4

all: sorter servo_pwm

sorter: engine.cpp hw.cpp ocr_client.cpp llm_client.cpp main.cpp
	$(CXX) $(CXXFLAGS) $(CPPFLAGS) -o $@ $^ \
	  -lcurl -lopencv_core -lopencv_imgproc -lopencv_videoio -lopencv_imgcodecs -lopencv_highgui

servo_pwm: servo_pwm.c
	$(CC) -O2 -o $@ $< -llgpio

test_engine: engine.cpp test_engine.cpp
	$(CXX) $(CXXFLAGS) $(CPPFLAGS) -o $@ $^ -lopencv_core -lopencv_imgproc

test: test_engine
	./test_engine

clean:
	rm -f sorter servo_pwm test_engine *.o

.PHONY: all test clean
