# stitchd — custom GPU compositor for restitch.
# Links our own libav* (static, from the ffmpeg-builder stage / stitchd-dev
# image at /opt/ffmpeg) for RTSP I/O + NVDEC/NVENC; all compositing is our
# own CUDA. See plans/custom-compositor.md.
cmake_minimum_required(VERSION 3.24)
project(stitchd LANGUAGES CXX CUDA)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CUDA_STANDARD 17)
set(CMAKE_CUDA_ARCHITECTURES 89) # Ada / RTX 4090 (sm_89)

if(NOT CMAKE_BUILD_TYPE)
  set(CMAKE_BUILD_TYPE Release)
endif()

# --- libav* (our build) via pkg-config; static ---
find_package(PkgConfig REQUIRED)
set(ENV{PKG_CONFIG_PATH} "/opt/ffmpeg/lib/pkgconfig")
pkg_check_modules(LIBAV REQUIRED IMPORTED_TARGET
  libavformat libavcodec libavutil libswresample)
# Static libav pulls transitive system deps; pkg-config --static resolves them.
pkg_check_modules(LIBAV_STATIC REQUIRED
  libavformat libavcodec libavutil libswresample)

# --- CUDA runtime + NPP (from the CUDA devel image) ---
find_package(CUDAToolkit REQUIRED)

# libdatachannel's exported targets reference OpenSSL::SSL/Crypto and
# Threads::Threads, so those imported targets must exist BEFORE its config is
# loaded or set_target_properties fails on them.
find_package(Threads REQUIRED)
find_package(OpenSSL REQUIRED)

# --- libdatachannel (WebRTC: ICE + DTLS-SRTP + SDP), static ---
# Optional so a dev checkout without it still builds; stitchd simply reports
# WebRTC unavailable rather than failing to compile.
find_package(LibDataChannel QUIET PATHS /opt/libdatachannel/lib/cmake/LibDataChannel)
if(LibDataChannel_FOUND)
  message(STATUS "libdatachannel found — WebRTC output enabled")
else()
  message(STATUS "libdatachannel NOT found — WebRTC output disabled")
endif()

file(GLOB STITCHD_SOURCES CONFIGURE_DEPENDS
  "${CMAKE_CURRENT_SOURCE_DIR}/src/*.cpp"
  "${CMAKE_CURRENT_SOURCE_DIR}/src/*.cu")

# webrtc.cpp includes <rtc/rtc.hpp>, so it can only be built when
# libdatachannel was found. Drop it otherwise so a checkout without the
# dependency still compiles.
if(NOT LibDataChannel_FOUND)
  list(REMOVE_ITEM STITCHD_SOURCES "${CMAKE_CURRENT_SOURCE_DIR}/src/webrtc.cpp")
endif()

add_executable(stitchd ${STITCHD_SOURCES})

target_include_directories(stitchd PRIVATE
  ${LIBAV_INCLUDE_DIRS}
  ${CMAKE_CURRENT_SOURCE_DIR}/src)

# Link the static libav archives + their transitive deps, then CUDA runtime.
# (stitchd's compositing is our own CUDA kernels — no NPP dependency.)
target_link_directories(stitchd PRIVATE ${LIBAV_STATIC_LIBRARY_DIRS})
target_link_libraries(stitchd PRIVATE
  ${LIBAV_STATIC_STATIC_LIBRARIES}
  CUDA::cudart
  pthread m dl)

if(LibDataChannel_FOUND)
  target_link_libraries(stitchd PRIVATE LibDataChannel::LibDataChannel)
  target_compile_definitions(stitchd PRIVATE STITCHD_WEBRTC=1)
endif()
