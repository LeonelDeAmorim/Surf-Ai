#Import DXcam to capture screenshots using Windows Desktop Duplication
import dxcam

print("Momentum Mod - DXcam Timestamp Test")
print("Press Ctrl+C to stop.")

#Create a DXcam capture instance for the primary output
camera = dxcam.create(
    output_color="BGRA",
    output_idx=0
)

try:
    #Start capture
    #target_fps = 0 captures as fast as possible without artificial frame limiting
    #video_mode = false only captures when the screen actually updates
    camera.start(
        target_fps=0,
        video_mode=False
    )

    while True:
        #Retrieve the latest captured frame along with its capture timestamp
        result = camera.get_latest_frame(with_timestamp=True)

        if result is None:
            continue

        frame, frame_timestamp = result

except KeyboardInterrupt:
    print("\nDXcam capture stopped.")

finally:
    #Stop screen capture and release the DXcam resources
    camera.stop()
    camera.release()