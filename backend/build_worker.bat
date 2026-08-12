@echo off
REM ============================================================================
REM  Freezes the LucidCut Python worker into a standalone exe (no Python needed
REM  on the user's machine). Run this from C:\LucidCut\backend with the venv
REM  active:   .venv\Scripts\activate   then:   build_worker.bat
REM  Output:   dist\lucidcut-worker\lucidcut-worker.exe
REM ============================================================================

pyinstaller --noconfirm --onedir --name lucidcut-worker worker\lucidcut_worker.py --paths worker --hidden-import process_video --hidden-import track_object --hidden-import train_model --hidden-import features --collect-all whisper --collect-all faster_whisper --collect-all nudenet --collect-all cv2 --collect-all sklearn --collect-all torch --collect-all transformers

echo.
echo ============================================================================
echo  Done. Verifying it is the dispatcher build...
echo ============================================================================
dist\lucidcut-worker\lucidcut-worker.exe
echo.
echo  ^^ That line should read: usage: lucidcut-worker ^<process^|track^|train^>
echo  If it says "process_video.py" instead, the freeze used the wrong script.
