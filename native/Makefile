# Makefile for circuit-runner — native ggml layer runner

# Override with `make GGML_BINS=/path/to/@node-llama-cpp/.../bins/linux-x64` (or set it in the env).
GGML_BINS   ?= $(HOME)/circuit-decentralized-llm/node_modules/@node-llama-cpp/linux-x64/bins/linux-x64
GGML_INCL   := /tmp/llama-cpp-src/ggml/include

CC       := gcc
CFLAGS   := -O2 -std=c11 -Wall -Wextra -Wno-unused-parameter \
            -I$(GGML_INCL)
LDFLAGS  := -L$(GGML_BINS) \
            -Wl,-rpath,$(GGML_BINS) \
            -lggml-base \
            -lggml-cpu-x64 \
            -lm -lpthread

TARGET   := circuit-runner
SRC      := circuit-runner.c

.PHONY: all clean

all: $(TARGET)

$(TARGET): $(SRC)
	$(CC) $(CFLAGS) -o $@ $< $(LDFLAGS)
	@echo "Built: $(TARGET)"

clean:
	rm -f $(TARGET)
