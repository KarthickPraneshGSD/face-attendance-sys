import cv2
import mediapipe as mp
import numpy as np
import os
import json

# Initialize Mediapipe
mp_face_detection = mp.solutions.face_detection
face_detection = mp_face_detection.FaceDetection(model_selection=1, min_detection_confidence=0.5)

# Initialize OpenCV LBPH Face Recognizer
recognizer = cv2.face.LBPHFaceRecognizer_create()
DATA_DIR = "face_data"
os.makedirs(DATA_DIR, exist_ok=True)

MODEL_PATH = os.path.join(DATA_DIR, "trainer.yml")

def get_face_encoding(image_bytes):
    """
    Extracts the face region and returns it as a normalized grayscale image.
    For LBPH, we store the actual face samples and train the model.
    In this implementation, we return the face pixels as the 'encoding' 
    (flattened or as a list) or just handle the training here.
    """
    nparr = np.frombuffer(image_bytes, np.uint8)
    img = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    
    # Detect face using Mediapipe
    results = face_detection.process(cv2.cvtColor(img, cv2.COLOR_BGR2RGB))
    
    if not results.detections:
        return None
        
    # Get the first face
    detection = results.detections[0]
    bbox = detection.location_data.relative_bounding_box
    ih, iw, _ = img.shape
    x, y, w, h = int(bbox.xmin * iw), int(bbox.ymin * ih), int(bbox.width * iw), int(bbox.height * ih)
    
    # Crop and resize
    face_roi = gray[max(0, y):y+h, max(0, x):x+w]
    if face_roi.size == 0:
        return None
        
    face_roi = cv2.resize(face_roi, (200, 200))
    # For LBPH, we'll return the flattened pixels as a list to store in DB
    return face_roi.tolist()

def train_recognizer(known_faces):
    """
    Trains the LBPH recognizer with known face data.
    known_faces: list of tuples (emp_id, face_pixels_list)
    """
    if not known_faces:
        return
        
    ids = []
    faces = []
    for emp_id, face_list in known_faces:
        ids.append(emp_id)
        faces.append(np.array(face_list, dtype=np.uint8))
        
    recognizer.train(faces, np.array(ids))
    recognizer.write(MODEL_PATH)

def compare_faces(known_faces, unknown_encoding_bytes):
    """
    Compares unknown face using the trained recognizer.
    """
    if not known_faces:
        return None, 1.0
        
    # Get the face ROI from the scan
    unknown_face_list = get_face_encoding(unknown_encoding_bytes)
    if unknown_face_list is None:
        return None, 1.0
        
    unknown_face = np.array(unknown_face_list, dtype=np.uint8)
    
    # Check if model exists, if not train it once
    if not os.path.exists(MODEL_PATH):
        train_recognizer(known_faces)
    else:
        # Load the latest model
        recognizer.read(MODEL_PATH)
        
    label, confidence = recognizer.predict(unknown_face)
    
    # LBPH confidence is distance (lower is better). 0 is perfect match.
    # Threshold for LBPH is typically around 50-70.
    if confidence < 65:
        return label, float(confidence)
        
    return None, float(confidence)
